import os from "node:os";
import path from "node:path";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import yaml from "js-yaml";

const AI_OFFICE = path.join(os.homedir(), "notes-brain", "Skb-Ai-Office");

const TASKS_DIR = path.join(AI_OFFICE, "Tasks");

const POLL_INTERVAL = 5000;

type Agent = "FE" | "BE" | "QA";

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

const AGENTS: Agent[] = ["FE", "BE", "QA"];

const runningTasks = new Set<string>();

// ============================================================
// Utility
// ============================================================

async function ensureDirectories(): Promise<void> {
  await mkdir(AI_OFFICE, { recursive: true });
  await mkdir(TASKS_DIR, { recursive: true });
}

function isAgent(value: string | undefined): value is Agent {
  return value === "FE" || value === "BE" || value === "QA";
}

function parseFrontmatter(content: string): {
  frontmatter: TaskFrontmatter;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  if (!match) {
    throw new Error("Invalid frontmatter");
  }

  const frontmatter = yaml.load(match[1] ?? "") as TaskFrontmatter;

  return {
    frontmatter: frontmatter ?? {},
    body: match[2] ?? "",
  };
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

async function updateTaskStatus(task: Task, status: string): Promise<void> {
  const content = await readFile(task.path, "utf8");

  const updated = content.replace(/^status:\s*.*$/m, `status: ${status}`);

  await writeFile(task.path, updated, "utf8");

  task.frontmatter.status = status;
}

// ============================================================
// Task discovery
// ============================================================

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
      console.error(`[Orchestrator] Failed to read ${file}`, error);
    }
  }

  return tasks;
}

// ============================================================
// Dependency
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
// Worker prompt
// ============================================================

function buildWorkerPrompt(task: Task): string {
  const id = task.frontmatter.id ?? "UNKNOWN";
  const project = task.frontmatter.project ?? "UNKNOWN";
  const title = task.frontmatter.title ?? "UNKNOWN";

  return `
You are an AI Office worker.

You have been assigned task:

Task ID: ${id}
Project: ${project}
Title: ${title}

AI Office root:

${AI_OFFICE}

Task file:

${task.path}

Instructions:

1. Read the task file.
2. Read the relevant project documentation.
3. Read System/Task-Protocol.md.
4. Verify the task requirement and acceptance criteria.
5. Check dependencies.
6. Perform the work required by the task.
7. Run relevant tests.
8. Record implementation/testing evidence in the task file.
9. Do not change the requirement silently.
10. Do not mark the task DONE.
11. When implementation is complete, change the task status to REVIEW.

Do not ask the user for instructions.

The task file is the communication layer between
PM, Orchestrator, workers, and QA.

Work only within the scope of this task.
`.trim();
}

// ============================================================
// Worker execution
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
    console.log(`[Orchestrator] Starting ${agent} for ${taskId}`);
    console.log(`[Orchestrator] Task: ${task.frontmatter.title ?? "-"}`);
    console.log("============================================================");

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
     * Worker sendiri bertanggung jawab mengubah
     * status IN-PROGRESS -> REVIEW.
     *
     * Kalau worker crash / gagal sebelum REVIEW,
     * kita kembalikan task ke TODO supaya bisa
     * dicoba lagi pada polling berikutnya.
     */
    if (exitCode !== 0) {
      const latestTask = await readTask(task.path);

      if (latestTask.frontmatter.status === "in-progress") {
        await updateTaskStatus(latestTask, "todo");
      }

      console.error(`[Orchestrator] Worker failed for ${taskId}`);
    }
  } catch (error) {
    console.error(`[Orchestrator] Worker error for ${taskId}`, error);

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
// Dispatch
// ============================================================

async function dispatchTasks(): Promise<void> {
  const tasks = await getTasks();

  if (tasks.length === 0) {
    return;
  }

  for (const task of tasks) {
    const { id, status, assignee } = task.frontmatter;

    if (!id) {
      continue;
    }

    /*
     * Hanya task TODO yang diproses.
     */
    if (status !== "todo") {
      continue;
    }

    /*
     * Pastikan assignee valid.
     *
     * Ini juga menyelesaikan error:
     * string | undefined -> Agent
     */
    if (!isAgent(assignee)) {
      console.log(`[Orchestrator] ${id} skipped: invalid assignee`);

      continue;
    }

    /*
     * Jangan menjalankan task yang dependency-nya
     * belum selesai.
     */
    const dependenciesDone = await areDependenciesDone(task, tasks);

    if (!dependenciesDone) {
      continue;
    }

    /*
     * Jangan menjalankan task yang sama dua kali.
     */
    if (runningTasks.has(id)) {
      continue;
    }

    /*
     * QA hanya memproses REVIEW.
     *
     * Jadi TODO FE/BE langsung jalan,
     * sedangkan TODO QA tidak otomatis diproses.
     *
     * QA akan dipicu dari REVIEW.
     */
    if (assignee === "QA") {
      continue;
    }

    /*
     * Jalankan worker tanpa await supaya
     * orchestrator tetap polling.
     */
    void runWorker(task, assignee);
  }
}

// ============================================================
// QA dispatch
// ============================================================

async function dispatchQA(): Promise<void> {
  const tasks = await getTasks();

  for (const task of tasks) {
    const { id, status, assignee } = task.frontmatter;

    if (!id) {
      continue;
    }

    /*
     * QA hanya bekerja pada task REVIEW.
     *
     * Untuk sekarang QA task memakai assignee:
     * QA dan status REVIEW.
     */
    if (status !== "review") {
      continue;
    }

    if (assignee !== "BE" && assignee !== "FE") {
      continue;
    }

    if (runningTasks.has(id)) {
      continue;
    }

    /*
     * Kita jalankan QA dengan agent QA,
     * tanpa mengubah assignee task menjadi QA.
     *
     * QA diberi instruksi memverifikasi task REVIEW.
     */
    runningTasks.add(id);

    try {
      console.log("");
      console.log(`[Orchestrator] Starting QA for ${id}`);

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
7. Test happy paths and important edge cases.
8. Check regression impact where relevant.
9. Record QA evidence in the task file.

If PASS:
- change status REVIEW -> QA
- then change status QA -> DONE

If FAIL:
- change status REVIEW -> BLOCKED
- clearly document the defect and evidence.

Do not change the requirement.
Do not ask the user for instructions.
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
      console.error(`[Orchestrator] QA error for ${id}`, error);
    } finally {
      runningTasks.delete(id);
    }
  }
}

// ============================================================
// Main loop
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

async function main(): Promise<void> {
  console.log("");
  console.log("============================================================");
  console.log("AI Office Orchestrator");
  console.log("============================================================");
  console.log(`AI Office: ${AI_OFFICE}`);
  console.log(`Tasks:     ${TASKS_DIR}`);
  console.log(`Poll:      ${POLL_INTERVAL}ms`);
  console.log("============================================================");
  console.log("");

  await ensureDirectories();

  await tick();

  setInterval(() => {
    void tick();
  }, POLL_INTERVAL);
}

void main();
