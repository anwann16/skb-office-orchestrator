import { getTasks, findTaskById } from "../task/repository";
import { runQA, runWorker, runningTasks } from "../worker/runner";
import type { Agent, Task } from "../types";

function isDependencyCompleted(dependencyId: string, tasks: Task[]): boolean {
  const dependency = tasks.find((task) => task.id === dependencyId);

  return dependency?.status === "done";
}

function dependenciesCompleted(task: Task, tasks: Task[]): boolean {
  if (!task.depends_on || task.depends_on.length === 0) {
    return true;
  }

  return task.depends_on.every((dependencyId) =>
    isDependencyCompleted(dependencyId, tasks),
  );
}

function getAgent(assignee: string): Agent | null {
  const normalized = assignee.toUpperCase();

  if (normalized === "FE" || normalized === "BE" || normalized === "QA") {
    return normalized;
  }

  return null;
}

export async function dispatchWorkers(): Promise<void> {
  const tasks = await getTasks();

  for (const task of tasks) {
    if (runningTasks.has(task.id)) {
      continue;
    }

    /*
     * FE / BE worker.
     */
    if (task.status === "todo" || task.status === "blocked") {
      const agent = getAgent(task.assignee);

      if (agent !== "FE" && agent !== "BE") {
        continue;
      }

      /*
       * Jangan menjalankan task yang dependency-nya
       * belum selesai.
       */
      if (!dependenciesCompleted(task, tasks)) {
        continue;
      }

      /*
       * Resolve task sekali lagi sebelum dispatch.
       * Ini mencegah stale snapshot.
       */
      const latest = await findTaskById(task.id);

      if (!latest) {
        continue;
      }

      if (latest.status !== "todo" && latest.status !== "blocked") {
        continue;
      }

      /*
       * Jangan await di sini kalau mau FE/BE
       * bisa jalan paralel.
       */
      void runWorker(latest, agent);

      continue;
    }
  }
}

export async function dispatchQA(): Promise<void> {
  const tasks = await getTasks();

  for (const task of tasks) {
    if (runningTasks.has(task.id)) {
      continue;
    }

    if (task.status !== "review") {
      continue;
    }

    /*
     * Resolve ulang task.
     */
    const latest = await findTaskById(task.id);

    if (!latest) {
      continue;
    }

    if (latest.status !== "review") {
      continue;
    }

    void runQA(latest);
  }
}
