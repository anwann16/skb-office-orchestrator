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

    PWD: projectPath,
  };
}

function buildOpenCodeCommand(): string {
  return `
cd -- "$PROJECT_PATH" &&
exec "$OPENCODE_PATH" run \
  --standalone \
  --agent "$OPENCODE_AGENT" \
  --model "$OPENCODE_MODEL" \
  --auto \
  "$OPENCODE_PROMPT"
`;
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

  const workerProcess = Bun.spawn(
    ["/bin/bash", "-lc", buildOpenCodeCommand()],
    {
      cwd: projectPath,

      stdout: "inherit",
      stderr: "inherit",

      env: {
        ...getOpenCodeEnv(projectPath),

        PROJECT_PATH: projectPath,
        OPENCODE_PATH,
        OPENCODE_AGENT: agent.toLowerCase(),
        OPENCODE_MODEL: model,
        OPENCODE_PROMPT: prompt,
      },
    },
  );

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
    const latest = await findTaskById(task.id);

    if (!latest) {
      console.error(`[Worker] Task ${task.id} tidak ditemukan`);

      return null;
    }

    if (latest.status !== "todo" && latest.status !== "blocked") {
      console.log(`[Worker] ${task.id} status sekarang ${latest.status}, skip`);

      return null;
    }

    // Orchestrator owns lifecycle.
    await moveTaskById(task.id, "in-progress");

    const workerTask = await findTaskById(task.id);

    if (!workerTask) {
      console.error(`[Worker] Task ${task.id} hilang setelah IN-PROGRESS`);

      return null;
    }

    const prompt = buildWorkerPrompt(workerTask, agent);

    const exitCode = await runOpenCode(workerTask, agent, prompt);

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

    if (exitCode === 0) {
      if (updatedTask.status === "in-progress") {
        await moveTaskById(task.id, "review");

        console.log(`[Worker] ${task.id}: IN-PROGRESS -> REVIEW`);
      }
    } else {
      if (updatedTask.status === "in-progress") {
        await moveTaskById(task.id, "todo");

        console.log(`[Worker] ${task.id}: IN-PROGRESS -> TODO`);
      }
    }

    return {
      taskId: task.id,
      agent,
      exitCode,
    };
  } catch (error) {
    console.error(`[Worker] Error pada ${task.id}:`, error);

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
    const latest = await findTaskById(task.id);

    if (!latest) {
      console.error(`[QA] Task ${task.id} tidak ditemukan`);

      return null;
    }

    if (latest.status !== "review") {
      console.log(`[QA] ${task.id} status sekarang ${latest.status}, skip`);

      return null;
    }

    // Orchestrator owns lifecycle.
    await moveTaskById(task.id, "qa");

    const qaTask = await findTaskById(task.id);

    if (!qaTask) {
      console.error(`[QA] Task ${task.id} hilang setelah QA state`);

      return null;
    }

    const projectPath = getProjectPath(qaTask.project);

    const model = WORKER_MODELS.QA;
    const prompt = buildQAPrompt(qaTask);

    console.log(`
============================================================
[QA]
Task  : ${qaTask.id}
Model : ${model}
CWD   : ${projectPath}
============================================================
`);

    const qaProcess = Bun.spawn(["/bin/bash", "-lc", buildOpenCodeCommand()], {
      cwd: projectPath,

      stdout: "inherit",
      stderr: "inherit",

      env: {
        ...getOpenCodeEnv(projectPath),

        PROJECT_PATH: projectPath,
        OPENCODE_PATH,
        OPENCODE_AGENT: "qa",
        OPENCODE_MODEL: model,
        OPENCODE_PROMPT: prompt,
      },
    });

    const exitCode = await qaProcess.exited;

    const updatedTask = await findTaskById(task.id);

    if (!updatedTask) {
      console.error(`[QA] Task ${task.id} tidak ditemukan setelah QA selesai`);

      return {
        taskId: task.id,
        agent: "QA",
        exitCode,
      };
    }

    if (exitCode === 0) {
      if (updatedTask.status === "qa") {
        await moveTaskById(task.id, "done");

        console.log(`[QA] ${task.id}: QA -> DONE`);
      }
    } else {
      if (updatedTask.status === "qa") {
        await moveTaskById(task.id, "blocked");

        console.log(`[QA] ${task.id}: QA -> BLOCKED`);
      }
    }

    return {
      taskId: task.id,
      agent: "QA",
      exitCode,
    };
  } catch (error) {
    console.error(`[QA] Error pada ${task.id}:`, error);

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
