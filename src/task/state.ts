import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { STATUS_FOLDERS, TASKS_DIR } from "../config";
import { findTaskById } from "./repository";
import type { Task, TaskStatus } from "../types";

function updateFrontmatterStatus(content: string, status: TaskStatus): string {
  return content.replace(
    /^(---\s*\n[\s\S]*?^status:\s*)([^\n]+)([\s\S]*?^---\s*)/m,
    `$1${status}$3`,
  );
}

function updateFrontmatterDate(content: string): string {
  const today = new Date().toISOString().slice(0, 10);

  if (/^updated_at:/m.test(content)) {
    return content.replace(/^updated_at:.*$/m, `updated_at: ${today}`);
  }

  return content.replace(/^---\s*$/m, `updated_at: ${today}\n---`);
}

function updateTaskContent(content: string, status: TaskStatus): string {
  let updated = updateFrontmatterStatus(content, status);

  updated = updateFrontmatterDate(updated);

  return updated;
}

export async function moveTaskToStatus(
  task: Task,
  status: TaskStatus,
): Promise<Task | null> {
  const folderName = STATUS_FOLDERS[status];

  if (!folderName) {
    throw new Error(`Status tidak valid: ${status}`);
  }

  const updatedContent = updateTaskContent(task.content, status);

  const projectDir = path.join(TASKS_DIR, task.project);

  const targetDir = path.join(projectDir, folderName);

  await mkdir(targetDir, {
    recursive: true,
  });

  const targetPath = path.join(targetDir, path.basename(task.filePath));

  /*
   * Kalau file sudah berada di lokasi target,
   * cukup update content.
   */
  if (path.resolve(task.filePath) === path.resolve(targetPath)) {
    await writeFile(targetPath, updatedContent, "utf8");

    return {
      ...task,
      status,
      content: updatedContent,
      filePath: targetPath,
    };
  }

  /*
   * Tulis content terbaru ke file lama terlebih dahulu.
   */
  await writeFile(task.filePath, updatedContent, "utf8");

  /*
   * Rename atomic pada filesystem yang sama.
   */
  try {
    await rename(task.filePath, targetPath);
  } catch (error: any) {
    /*
     * Bisa terjadi worker lain sudah memindahkan
     * file tersebut.
     *
     * Jangan langsung dianggap fatal.
     */
    const latest = await findTaskById(task.id);

    if (latest) {
      return latest;
    }

    throw error;
  }

  return {
    ...task,
    status,
    content: updatedContent,
    filePath: targetPath,
  };
}

export async function moveTaskById(
  taskId: string,
  status: TaskStatus,
): Promise<Task | null> {
  const task = await findTaskById(taskId);

  if (!task) {
    console.log(`[State] Task ${taskId} tidak ditemukan`);

    return null;
  }

  if (task.status === status) {
    /*
     * Tidak perlu rename ulang.
     */
    return task;
  }

  console.log(
    `[Orchestrator] ${task.id}: ${task.status.toUpperCase()} -> ${status.toUpperCase()}`,
  );

  return moveTaskToStatus(task, status);
}
