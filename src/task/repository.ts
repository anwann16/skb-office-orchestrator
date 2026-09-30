import { readdir } from "node:fs/promises";
import path from "node:path";

import { TASKS_DIR } from "../config";
import { readTask } from "./parser";
import type { Task } from "../types";

async function walkMarkdownFiles(directory: string): Promise<string[]> {
  const result: string[] = [];

  let entries;

  try {
    entries = await readdir(directory, {
      withFileTypes: true,
    });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...(await walkMarkdownFiles(fullPath)));

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(fullPath);
    }
  }

  return result;
}

export async function getTaskFiles(): Promise<string[]> {
  return walkMarkdownFiles(TASKS_DIR);
}

export async function getTasks(): Promise<Task[]> {
  const files = await getTaskFiles();

  const tasks: Task[] = [];

  for (const filePath of files) {
    try {
      const task = await readTask(filePath);

      tasks.push(task);
    } catch (error) {
      console.error(`[Repository] Gagal membaca task: ${filePath}`, error);
    }
  }

  return tasks;
}

export async function findTaskById(taskId: string): Promise<Task | null> {
  const files = await getTaskFiles();

  for (const filePath of files) {
    try {
      const task = await readTask(filePath);

      if (task.id === taskId) {
        return task;
      }
    } catch {
      // File mungkin sedang dipindahkan.
      // Lanjutkan pencarian.
    }
  }

  return null;
}
