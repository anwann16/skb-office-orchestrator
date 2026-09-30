import os from "node:os";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { load } from "js-yaml";

// ============================================================
// CONFIG
// ============================================================

const AI_OFFICE = path.join(os.homedir(), "notes-brain", "Skb-Ai-Office");

const TASKS_DIR = path.join(AI_OFFICE, "Tasks");

const POLL_INTERVAL = 5000;

type Agent = "FE" | "BE" | "QA";

const runningTasks = new Set<string>();

// ============================================================
// TYPES
// ============================================================

type TaskFrontmatter = {
  id?: string;
  project?: string;
  title?: string;
  type?: string;
  priority?: string;
  status?: string;
  assignee?: string;
  depends_on?: string[];
  created_by?: string;
  created_at?: string;
  updated_at?: string;
};

type Task = {
  path: string;
  frontmatter: TaskFrontmatter;
  body: string;
};

// ============================================================
// AGENT VALIDATION
// ============================================================

function isAgent(value: string | undefined): value is Agent {
  return value === "FE" || value === "BE" || value === "QA";
}

// ============================================================
// FRONTMATTER
// ============================================================

function parseFrontmatter(content: string): {
  frontmatter: TaskFrontmatter;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  if (!match) {
    throw new Error("Invalid markdown frontmatter");
  }

  const frontmatter = load(match[1] ?? "") as TaskFrontmatter;

  return {
    frontmatter: frontmatter ?? {},
    body: match[2] ?? "",
  };
}

// ============================================================
// FILE SYSTEM
// ============================================================

async function ensureDirectories(): Promise<void> {
  await mkdir(AI_OFFICE, {
    recursive: true,
  });

  await mkdir(TASKS_DIR, {
    recursive: true,
  });
}

async function readTask(filePath: string): Promise<Task> {
  const content = await readFile(filePath, "utf8");

  const { frontmatter, body } = parseFrontmatter(content);

  return {
    path: filePath,
    frontmatter,
    body,
  };
}

async function findMarkdownFiles(directory: string): Promise<string[]> {
  const results: string[] = [];

  let entries;

  try {
    entries = await readdir(directory, {
      withFileTypes: true,
    });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const nested = await findMarkdownFiles(fullPath);

      results.push(...nested);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

// ============================================================
// TASK DISCOVERY
// ============================================================

async function getTasks(): Promise<Task[]> {
  const files = await findMarkdownFiles(TASKS_DIR);

  const tasks: Task[] = [];

  for (const file of files) {
    try {
      const task = await readTask(file);

      if (!task.frontmatter.id) {
        continue;
      }

      tasks.push(task);
    } catch (error) {
      console.error(`[Orchestrator] Failed to read task: ${file}`, error);
    }
  }

  return tasks;
}

// ============================================================
// TASK STATUS
// ============================================================

async function updateTaskStatus(task: Task, status: string): Promise<void> {
  const content = await readFile(task.path, "utf8");

  const updated = content.replace(/^status:\s*.*$/m, `status: ${status}`);

  await writeFile(task.path, updated, "utf8");

  task.frontmatter.status = status;
}

// ============================================================
// DEPENDENCY
// ============================================================

async function areDependenciesDone(
  task: Task,
  allTasks: Task[],
): Promise<boolean> {
  const dependencies = task.frontmatter.depends_on ?? [];

  if (dependencies.length === 0) {
    return true;
  }

  for (const dependencyId of dependencies) {
    const dependency = allTasks.find(
      (item) => item.frontmatter.id === dependencyId,
    );

    if (!dependency) {
      console.log(
        `[Orchestrator] ${task.frontmatter.id} waiting: dependency ${dependencyId} not found`,
      );

      return false;
    }

    if (dependency.frontmatter.status !== "done") {
      console.log(
        `[Orchestrator] ${task.frontmatter.id} waiting: ${dependencyId} is ${dependency.frontmatter.status}`,
      );

      return false;
    }
  }

  return true;
}

// ============================================================
// WORKER PROMPT
// ============================================================

function buildWorkerPrompt(task: Task): string {
  const id = task.frontmatter.id ?? "UNKNOWN";

  const project = task.frontmatter.project ?? "UNKNOWN";

  const title = task.frontmatter.title ?? "UNKNOWN";

  return `
You are an AI Office worker.

You have been assigned this task:

Task ID: ${id}
Project: ${project}
Title: ${title}

AI Office root:

${AI_OFFICE}

Task file:

${task.path}

Follow these instructions:

1. Read the task file.
2. Read the relevant project documentation.
3. Read System/Task-Protocol.md.
4. Verify the task requirement.
5. Verify the acceptance criteria.
6. Check task dependencies.
7. Perform the work required by the task.
8. Run relevant tests.
9. Record clear evidence in the task file.
10. Do not change the requirement silently.
11. Do not mark the task DONE.
12. When implementation is complete, change the task status to REVIEW.

Do not ask the user for instructions.

The task file is the communication layer between
PM, Orchestrator, workers, and QA.

Work only within the scope of this task.
`.trim();
}

// ============================================================
// RUN WORKER
// ============================================================

async function runWorker(task: Task, agent: Agent): Promise<void> {
  const taskId = task.frontmatter.id;

  if (!taskId) {
    return;
  }

  if (runningTasks.has(taskId)) {
    console.log(`[Orchestrator] ${taskId} is already running`);

    return;
  }

  runningTasks.add(taskId);

  try {
    console.log("");
    console.log("============================================================");
    console.log(`[Orchestrator] Starting ${agent}`);
    console.log(`[Orchestrator] Task: ${taskId}`);
    console.log(`[Orchestrator] Title: ${task.frontmatter.title ?? "-"}`);
    console.log("============================================================");

    // TODO -> IN-PROGRESS
    await updateTaskStatus(task, "in-progress");

    const prompt = buildWorkerPrompt(task);

    const workerProcess = Bun.spawn(
      ["opencode", "run", "--agent", agent.toLowerCase(), "--auto", prompt],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const exitCode = await workerProcess.exited;

    console.log(
      `[Orchestrator] ${agent} finished ${taskId} with exit code ${exitCode}`,
    );

    /*
     * Worker harus mengubah:
     *
     * IN-PROGRESS -> REVIEW
     *
     * Worker tidak boleh mengubah:
     *
     * REVIEW -> DONE
     */

    if (exitCode !== 0) {
      try {
        const latestTask = await readTask(task.path);

        if (latestTask.frontmatter.status === "in-progress") {
          await updateTaskStatus(latestTask, "todo");
        }
      } catch (error) {
        console.error(`[Orchestrator] Failed to reset ${taskId}`, error);
      }

      console.error(`[Orchestrator] Worker failed: ${taskId}`);
    }
  } catch (error) {
    console.error(`[Orchestrator] Worker error: ${taskId}`, error);

    try {
      const latestTask = await readTask(task.path);

      if (latestTask.frontmatter.status === "in-progress") {
        await updateTaskStatus(latestTask, "todo");
      }
    } catch {
      // Ignore secondary error
    }
  } finally {
    runningTasks.delete(taskId);
  }
}

// ============================================================
// DISPATCH FE / BE
// ============================================================

async function dispatchTasks(): Promise<void> {
  const tasks = await getTasks();

  for (const task of tasks) {
    const { id, status, assignee } = task.frontmatter;

    if (!id) {
      continue;
    }

    // Only process TODO
    if (status !== "todo") {
      continue;
    }

    // Validate assignee
    if (!isAgent(assignee)) {
      console.log(`[Orchestrator] ${id} skipped: invalid assignee`);

      continue;
    }

    // QA is handled separately
    if (assignee === "QA") {
      continue;
    }

    // Check dependencies
    const dependenciesDone = await areDependenciesDone(task, tasks);

    if (!dependenciesDone) {
      continue;
    }

    // Prevent duplicate execution
    if (runningTasks.has(id)) {
      continue;
    }

    // Start worker
    void runWorker(task, assignee);
  }
}

// ============================================================
// DISPATCH QA
// ============================================================

async function dispatchQA(): Promise<void> {
  const tasks = await getTasks();

  for (const task of tasks) {
    const { id, status, assignee } = task.frontmatter;

    if (!id) {
      continue;
    }

    /*
     * QA bekerja setelah FE/BE
     * masuk REVIEW.
     */
    if (status !== "review") {
      continue;
    }

    /*
     * Hanya FE dan BE yang
     * diverifikasi QA.
     */
    if (assignee !== "FE" && assignee !== "BE") {
      continue;
    }

    if (runningTasks.has(id)) {
      continue;
    }

    runningTasks.add(id);

    try {
      console.log("");
      console.log(
        "============================================================",
      );
      console.log(`[Orchestrator] Starting QA`);
      console.log(`[Orchestrator] Task: ${id}`);
      console.log(
        "============================================================",
      );

      const prompt = `
You are the QA worker for AI Office.

Verify this task:

Task ID: ${id}
Project: ${task.frontmatter.project ?? "UNKNOWN"}
Title: ${task.frontmatter.title ?? "UNKNOWN"}

Task file:

${task.path}

AI Office root:

${AI_OFFICE}

Instructions:

1. Read the task.
2. Read the relevant project documentation.
3. Read System/Task-Protocol.md.
4. Verify every acceptance criterion.
5. Review implementation evidence.
6. Run relevant tests.
7. Test the happy path.
8. Test important edge cases.
9. Check error handling.
10. Check regression impact where relevant.
11. Record QA evidence in the task file.

If PASS:

- change status REVIEW -> QA
- then change status QA -> DONE

If FAIL:

- change status REVIEW -> BLOCKED
- document the defect clearly
- include reproducible evidence

Do not change the requirement silently.
Do not ask the user for instructions.
Do not implement the feature yourself.
`.trim();

      const qaProcess = Bun.spawn(
        ["opencode", "run", "--agent", "qa", "--auto", prompt],
        {
          stdout: "inherit",
          stderr: "inherit",
        },
      );

      const exitCode = await qaProcess.exited;

      console.log(
        `[Orchestrator] QA finished ${id} with exit code ${exitCode}`,
      );
    } catch (error) {
      console.error(`[Orchestrator] QA error: ${id}`, error);
    } finally {
      runningTasks.delete(id);
    }
  }
}

// ============================================================
// MAIN TICK
// ============================================================

async function tick(): Promise<void> {
  try {
    await ensureDirectories();

    await dispatchTasks();

    await dispatchQA();
  } catch (error) {
    console.error("[Orchestrator] Tick error:", error);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  console.log("");
  console.log("============================================================");
  console.log("                 AI OFFICE ORCHESTRATOR");
  console.log("============================================================");
  console.log(`AI Office : ${AI_OFFICE}`);
  console.log(`Tasks     : ${TASKS_DIR}`);
  console.log(`Poll      : ${POLL_INTERVAL}ms`);
  console.log("============================================================");
  console.log("");

  await ensureDirectories();

  // Run immediately
  await tick();

  // Continue polling
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL);
}

void main();
