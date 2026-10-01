import os from "node:os";
import path from "node:path";

import type { Agent, Task, WorkerResult } from "../types";
import { findTaskById } from "../task/repository";
import { moveTaskById } from "../task/state";
import { buildQAPrompt, buildWorkerPrompt } from "./prompt";
import { PROJECTS_ROOT, WORKER_MODELS } from "../config";

export const runningTasks = new Set<string>();

const OPENCODE_PATH = path.join(os.homedir(), ".opencode", "bin", "opencode");

function getProjectPath(project: string): string {
  return path.join(PROJECTS_ROOT, project.toLowerCase());
}

function getOpenCodeEnv(projectPath: string) {
  return {
    ...process.env,

    PATH: [
      path.join(os.homedir(), ".opencode", "bin"),
      path.join(os.homedir(), ".bun", "bin"),
      process.env.PATH ?? "",
    ].join(":"),

    // Make the intended project directory explicit.
    PWD: projectPath,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildOpenCodeCommand(
  projectPath: string,
  agent: string,
  model: string,
  prompt: string,
): string {
  return [
    // Explicitly enter the project before starting OpenCode.
    `cd -- ${shellQuote(projectPath)}`,

    // Replace bash with OpenCode.
    `exec ${shellQuote(OPENCODE_PATH)}`,

    "run",

    "--standalone",

    "--agent",
    shellQuote(agent),

    "--model",
    shellQuote(model),

    "--auto",

    shellQuote(prompt),
  ].join(" ");
}

async function runOpenCode(
  task: Task,
  agent: Agent,
  prompt: string,
): Promise<number> {
  const projectPath = getProjectPath(task.project);
  const model = WORKER_MODELS[agent];

  console.log(`
============================================================
[Worker]
Agent : ${agent}
Task  : ${task.id}
Model : ${model}
CWD   : ${projectPath}
============================================================
`);

  const command = buildOpenCodeCommand(
    projectPath,
    agent.toLowerCase(),
    model,
    prompt,
  );

  const workerProcess = Bun.spawn(["/bin/bash", "-lc", command], {
    cwd: projectPath,

    stdout: "inherit",
    stderr: "inherit",

    env: getOpenCodeEnv(projectPath),
  });

  return workerProcess.exited;
}

export async function runWorker(
  task: Task,
  agent: "FE" | "BE",
): Promise<WorkerResult | null> {
  if (runningTasks.has(task.id)) {
    console.log(`[Worker] ${task.id} sudah sedang berjalan`);

    return null;
  }

  runningTasks.add(task.id);

  try {
    /*
     * Always re-read the task before starting.
     * The file may have moved or changed since dispatch.
     */
    const latest = await findTaskById(task.id);

    if (!latest) {
      console.error(`[Worker] Task ${task.id} tidak ditemukan`);

      return null;
    }

    /*
     * Worker hanya boleh mengambil TODO atau BLOCKED.
     */
    if (latest.status !== "todo" && latest.status !== "blocked") {
      console.log(`[Worker] ${task.id} status sekarang ${latest.status}, skip`);

      return null;
    }

    /*
     * Orchestrator owns task lifecycle.
     *
     * Worker tidak boleh mengubah status sendiri.
     */
    await moveTaskById(task.id, "in-progress");

    const workerTask = await findTaskById(task.id);

    if (!workerTask) {
      console.error(`[Worker] Task ${task.id} hilang setelah IN-PROGRESS`);

      return null;
    }

    /*
     * Build prompt menggunakan task yang sudah berada
     * pada state IN-PROGRESS.
     */
    const prompt = buildWorkerPrompt(workerTask, agent);

    const exitCode = await runOpenCode(workerTask, agent, prompt);

    /*
     * Re-read task setelah worker selesai.
     *
     * Jangan menggunakan object task lama karena task
     * mungkin sudah berubah/moved.
     */
    const updatedTask = await findTaskById(task.id);

    if (!updatedTask) {
      console.error(
        `[Worker] Task ${task.id} tidak ditemukan setelah worker selesai`,
      );

      return {
        taskId: task.id,
        agent,
        exitCode,
      };
    }

    /*
     * Orchestrator menentukan hasil berdasarkan exit code.
     *
     * Worker TIDAK boleh menentukan REVIEW/ TODO sendiri.
     */
    if (exitCode === 0) {
      if (updatedTask.status === "in-progress") {
        await moveTaskById(task.id, "review");

        console.log(`[Worker] ${task.id} → REVIEW`);
      } else {
        console.log(
          `[Worker] ${task.id} selesai dengan exit 0, ` +
            `tetapi status sudah ${updatedTask.status}`,
        );
      }
    } else {
      if (updatedTask.status === "in-progress") {
        await moveTaskById(task.id, "todo");

        console.log(`[Worker] ${task.id} gagal (exit ${exitCode}) → TODO`);
      } else {
        console.log(
          `[Worker] ${task.id} gagal dengan exit ${exitCode}, ` +
            `tetapi status sudah ${updatedTask.status}`,
        );
      }
    }

    return {
      taskId: task.id,
      agent,
      exitCode,
    };
  } catch (error) {
    console.error(`[Worker] Error pada ${task.id}:`, error);

    /*
     * Kalau process/orchestrator error sebelum lifecycle
     * selesai, coba kembalikan task ke TODO.
     */
    try {
      const latest = await findTaskById(task.id);

      if (latest?.status === "in-progress") {
        await moveTaskById(task.id, "todo");
      }
    } catch (recoveryError) {
      console.error(`[Worker] Gagal recovery task ${task.id}:`, recoveryError);
    }

    return null;
  } finally {
    runningTasks.delete(task.id);
  }
}

export async function runQA(task: Task): Promise<WorkerResult | null> {
  if (runningTasks.has(task.id)) {
    console.log(`[QA] ${task.id} sudah sedang berjalan`);

    return null;
  }

  runningTasks.add(task.id);

  try {
    /*
     * Re-read task sebelum QA.
     */
    const latest = await findTaskById(task.id);

    if (!latest) {
      console.error(`[QA] Task ${task.id} tidak ditemukan`);

      return null;
    }

    /*
     * QA hanya boleh mengambil REVIEW.
     */
    if (latest.status !== "review") {
      console.log(`[QA] ${task.id} status sekarang ${latest.status}, skip`);

      return null;
    }

    /*
     * Orchestrator memindahkan REVIEW → QA.
     *
     * QA agent sendiri tidak boleh melakukan ini.
     */
    await moveTaskById(task.id, "qa");

    const qaTask = await findTaskById(task.id);

    if (!qaTask) {
      console.error(`[QA] Task ${task.id} hilang setelah QA state`);

      return null;
    }

    const prompt = buildQAPrompt(qaTask);
    const projectPath = getProjectPath(qaTask.project);

    const model = WORKER_MODELS.QA;

    console.log(`
============================================================
[QA]
Task  : ${qaTask.id}
Model : ${model}
CWD   : ${projectPath}
============================================================
`);

    const command = buildOpenCodeCommand(projectPath, "qa", model, prompt);

    const qaProcess = Bun.spawn(["/bin/bash", "-lc", command], {
      cwd: projectPath,

      stdout: "inherit",
      stderr: "inherit",

      env: getOpenCodeEnv(projectPath),
    });

    const exitCode = await qaProcess.exited;

    /*
     * Re-read task setelah QA selesai.
     */
    const updatedTask = await findTaskById(task.id);

    if (!updatedTask) {
      console.error(`[QA] Task ${task.id} tidak ditemukan setelah QA selesai`);

      return {
        taskId: task.id,
        agent: "QA",
        exitCode,
      };
    }

    /*
     * QA result ditentukan oleh exit code.
     *
     * exit 0 = PASS
     * exit != 0 = FAIL
     */
    if (exitCode === 0) {
      if (updatedTask.status === "qa") {
        await moveTaskById(task.id, "done");

        console.log(`[QA] ${task.id} PASS → DONE`);
      } else {
        console.log(
          `[QA] ${task.id} PASS (exit 0), ` +
            `tetapi status sudah ${updatedTask.status}`,
        );
      }
    } else {
      if (updatedTask.status === "qa") {
        await moveTaskById(task.id, "blocked");

        console.log(`[QA] ${task.id} FAIL (exit ${exitCode}) → BLOCKED`);
      } else {
        console.log(
          `[QA] ${task.id} FAIL (exit ${exitCode}), ` +
            `tetapi status sudah ${updatedTask.status}`,
        );
      }
    }

    return {
      taskId: task.id,
      agent: "QA",
      exitCode,
    };
  } catch (error) {
    console.error(`[QA] Error pada ${task.id}:`, error);

    /*
     * Recovery:
     *
     * Kalau QA crash ketika task masih QA,
     * kembalikan ke REVIEW supaya bisa dicoba lagi.
     */
    try {
      const latest = await findTaskById(task.id);

      if (latest?.status === "qa") {
        await moveTaskById(task.id, "review");
      }
    } catch (recoveryError) {
      console.error(`[QA] Gagal recovery task ${task.id}:`, recoveryError);
    }

    return null;
  } finally {
    runningTasks.delete(task.id);
  }
}
