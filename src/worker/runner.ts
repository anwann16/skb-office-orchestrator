import os from "node:os";
import path from "node:path";

import type { Agent, Task, WorkerResult } from "../types";
import { findTaskById } from "../task/repository";
import { moveTaskById } from "../task/state";
import { buildQAPrompt, buildWorkerPrompt } from "./prompt";

export const runningTasks = new Set<string>();

function getProjectPath(project: string): string {
  return path.join(
    os.homedir(),
    "notes-brain",
    "Skb-Ai-Office",
    "Projects",
    project,
  );
}

async function runOpenCode(
  task: Task,
  agent: Agent,
  prompt: string,
): Promise<number> {
  const projectPath = getProjectPath(task.project);

  /*
   * Kalau project directory belum ada,
   * OpenCode tetap bisa dijalankan dari AI Office.
   *
   * Untuk project sebenarnya, PM seharusnya sudah
   * membuat Projects/<project>.
   */
  const cwd = projectPath;

  console.log(`
============================================================
[Worker]
Agent : ${agent}
Task  : ${task.id}
Model : OpenCode config
CWD   : ${cwd}
============================================================
`);

  const workerProcess = Bun.spawn(
    [
      "opencode",
      "run",

      /*
       * Kita TIDAK menggunakan --model.
       * Model diambil dari OpenCode config.
       */
      "--agent",
      agent.toLowerCase(),

      "--auto",

      prompt,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      cwd,
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
    /*
     * Resolve ulang task berdasarkan ID.
     * Jangan percaya filePath lama.
     */
    const latest = await findTaskById(task.id);

    if (!latest) {
      console.log(`[Worker] Task ${task.id} tidak ditemukan`);

      return null;
    }

    /*
     * Worker hanya boleh mengambil TODO/BLOCKED.
     */
    if (latest.status !== "todo" && latest.status !== "blocked") {
      console.log(`[Worker] ${task.id} status sekarang ${latest.status}, skip`);

      return null;
    }

    await moveTaskById(task.id, "in-progress");

    /*
     * Resolve lagi setelah state transition.
     */
    const workerTask = await findTaskById(task.id);

    if (!workerTask) {
      console.log(`[Worker] Task ${task.id} hilang setelah IN-PROGRESS`);

      return null;
    }

    const prompt = buildWorkerPrompt(workerTask, agent);

    const exitCode = await runOpenCode(workerTask, agent, prompt);

    console.log(
      `[Orchestrator] ${agent} selesai mengerjakan ${task.id} dengan exit code ${exitCode}`,
    );

    /*
     * PENTING:
     *
     * Jangan readTask(workerTask.filePath).
     *
     * Worker mungkin sudah mengubah:
     *
     * IN-PROGRESS → REVIEW
     *
     * sehingga filePath lama sudah tidak ada.
     */
    const updatedTask = await findTaskById(task.id);

    if (!updatedTask) {
      console.log(
        `[Worker] Task ${task.id} tidak ditemukan setelah worker selesai`,
      );

      return {
        taskId: task.id,
        agent,
        exitCode,
      };
    }

    /*
     * Worker berhasil dan sudah mengubah status
     * menjadi REVIEW.
     */
    if (exitCode === 0 && updatedTask.status === "review") {
      /*
       * findTaskById() sudah menemukan lokasi terbaru.
       * moveTaskById() tidak menggunakan path lama.
       */
      await moveTaskById(task.id, "review");
    }

    /*
     * Worker crash sebelum mengubah status.
     */
    if (exitCode !== 0 && updatedTask.status === "in-progress") {
      await moveTaskById(task.id, "todo");
    }

    return {
      taskId: task.id,
      agent,
      exitCode,
    };
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
      console.log(`[QA] Task ${task.id} tidak ditemukan`);

      return null;
    }

    if (latest.status !== "review") {
      console.log(`[QA] ${task.id} status ${latest.status}, bukan REVIEW`);

      return null;
    }

    await moveTaskById(task.id, "qa");

    /*
     * Resolve ulang setelah REVIEW → QA.
     */
    const qaTask = await findTaskById(task.id);

    if (!qaTask) {
      console.log(`[QA] Task ${task.id} hilang setelah QA state`);

      return null;
    }

    const prompt = buildQAPrompt(qaTask);

    const projectPath = getProjectPath(qaTask.project);

    console.log(`
============================================================
[Orchestrator] Menjalankan QA
[Orchestrator] Task: ${qaTask.id}
============================================================
`);

    const qaProcess = Bun.spawn(
      ["opencode", "run", "--agent", "qa", "--auto", prompt],
      {
        stdout: "inherit",
        stderr: "inherit",
        cwd: projectPath,
      },
    );

    const exitCode = await qaProcess.exited;

    console.log(
      `[Orchestrator] QA selesai ${task.id} dengan exit code ${exitCode}`,
    );

    /*
     * Jangan menggunakan qaTask.filePath.
     * Cari lokasi terbaru berdasarkan ID.
     */
    const updatedTask = await findTaskById(task.id);

    if (!updatedTask) {
      console.log(`[QA] Task ${task.id} tidak ditemukan setelah QA selesai`);

      return {
        taskId: task.id,
        agent: "QA",
        exitCode,
      };
    }

    if (exitCode !== 0 && updatedTask.status === "qa") {
      /*
       * QA crash → kembali REVIEW
       */
      await moveTaskById(task.id, "review");
    }

    if (exitCode === 0 && updatedTask.status === "done") {
      await moveTaskById(task.id, "done");
    }

    if (exitCode === 0 && updatedTask.status === "blocked") {
      await moveTaskById(task.id, "blocked");
    }

    return {
      taskId: task.id,
      agent: "QA",
      exitCode,
    };
  } finally {
    runningTasks.delete(task.id);
  }
}
