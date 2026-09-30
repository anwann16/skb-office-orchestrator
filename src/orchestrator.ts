import os from "node:os";
import path from "node:path";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { load } from "js-yaml";

const AI_OFFICE = path.join(os.homedir(), "notes-brain", "Skb-Ai-Office");

const TASKS_DIR = path.join(AI_OFFICE, "Tasks");

const POLL_INTERVAL = 5000;

type Agent = "FE" | "BE" | "QA";

type TaskStatus =
  | "backlog"
  | "todo"
  | "in-progress"
  | "review"
  | "qa"
  | "blocked"
  | "done";

const STATUS_FOLDERS: Record<TaskStatus, string> = {
  backlog: "BACKLOG",
  todo: "TODO",
  "in-progress": "IN-PROGRESS",
  review: "REVIEW",
  qa: "QA",
  blocked: "BLOCKED",
  done: "DONE",
};

const VALID_STATUSES = new Set<TaskStatus>(
  Object.keys(STATUS_FOLDERS) as TaskStatus[],
);

const runningTasks = new Set<string>();

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

function isAgent(value: string | undefined): value is Agent {
  return value === "FE" || value === "BE" || value === "QA";
}

function isTaskStatus(value: string | undefined): value is TaskStatus {
  return value !== undefined && VALID_STATUSES.has(value as TaskStatus);
}

function parseFrontmatter(content: string): {
  frontmatter: TaskFrontmatter;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  if (!match) {
    throw new Error("Frontmatter Markdown tidak valid");
  }

  const frontmatter = load(match[1] ?? "") as TaskFrontmatter;

  return {
    frontmatter: frontmatter ?? {},
    body: match[2] ?? "",
  };
}

async function ensureDirectories(): Promise<void> {
  await mkdir(AI_OFFICE, { recursive: true });

  await mkdir(TASKS_DIR, { recursive: true });
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
      console.error(`[Orchestrator] Gagal membaca task: ${file}`, error);
    }
  }

  return tasks;
}

function getTaskStatus(task: Task): TaskStatus | null {
  const status = task.frontmatter.status;

  if (!isTaskStatus(status)) {
    return null;
  }

  return status;
}

function getStatusFolder(status: TaskStatus): string {
  return STATUS_FOLDERS[status];
}

function getExpectedTaskDirectory(task: Task, status: TaskStatus): string {
  const project = task.frontmatter.project;

  if (!project) {
    throw new Error(`Task ${task.frontmatter.id} tidak memiliki project`);
  }

  return path.join(TASKS_DIR, project, getStatusFolder(status));
}

function getExpectedTaskPath(task: Task, status: TaskStatus): string {
  const directory = getExpectedTaskDirectory(task, status);

  const fileName = path.basename(task.path);

  return path.join(directory, fileName);
}

async function updateTaskStatus(task: Task, status: TaskStatus): Promise<void> {
  const content = await readFile(task.path, "utf8");

  const updated = content.replace(/^status:\s*.*$/m, `status: ${status}`);

  await writeFile(task.path, updated, "utf8");

  task.frontmatter.status = status;
}

async function moveTaskToStatus(task: Task, status: TaskStatus): Promise<Task> {
  const targetDirectory = getExpectedTaskDirectory(task, status);

  const targetPath = getExpectedTaskPath(task, status);

  const currentPath = path.resolve(task.path);

  const resolvedTarget = path.resolve(targetPath);

  await mkdir(targetDirectory, { recursive: true });

  /*
   * Kalau file sudah berada di folder
   * yang sesuai, cukup pastikan statusnya benar.
   */
  if (currentPath === resolvedTarget) {
    await updateTaskStatus(task, status);

    return {
      ...task,
      frontmatter: {
        ...task.frontmatter,
        status,
      },
    };
  }

  /*
   * Jangan menimpa file task lain
   * kalau target sudah ada.
   */
  try {
    await access(targetPath);

    throw new Error(`File task tujuan sudah ada: ${targetPath}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("File task tujuan sudah ada:")
    ) {
      throw error;
    }
  }

  const oldFolder = path.basename(path.dirname(task.path));

  await updateTaskStatus(task, status);

  await rename(task.path, targetPath);

  console.log(
    `[Orchestrator] ${task.frontmatter.id}: ${oldFolder} -> ${getStatusFolder(status)}`,
  );

  return {
    ...task,
    path: targetPath,
    frontmatter: {
      ...task.frontmatter,
      status,
    },
  };
}

/**
 * Memastikan lokasi file sesuai dengan status task.
 *
 * Contoh:
 *
 * status: todo
 * -> Tasks/<project>/TODO/
 *
 * status: in-progress
 * -> Tasks/<project>/IN-PROGRESS/
 *
 * status: review
 * -> Tasks/<project>/REVIEW/
 *
 * dst.
 */
async function syncTaskLocations(tasks: Task[]): Promise<Task[]> {
  const syncedTasks: Task[] = [];

  for (const task of tasks) {
    const status = getTaskStatus(task);

    if (!status) {
      console.log(
        `[Orchestrator] ${task.frontmatter.id} dilewati: status tidak valid "${task.frontmatter.status}"`,
      );

      continue;
    }

    try {
      const syncedTask = await moveTaskToStatus(task, status);

      syncedTasks.push(syncedTask);
    } catch (error) {
      console.error(
        `[Orchestrator] Gagal sinkronisasi ${task.frontmatter.id}`,
        error,
      );
    }
  }

  return syncedTasks;
}

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
        `[Orchestrator] ${task.frontmatter.id} menunggu: dependency ${dependencyId} tidak ditemukan`,
      );

      return false;
    }

    if (dependency.frontmatter.status !== "done") {
      console.log(
        `[Orchestrator] ${task.frontmatter.id} menunggu: ${dependencyId} masih ${dependency.frontmatter.status}`,
      );

      return false;
    }
  }

  return true;
}

function buildWorkerPrompt(task: Task): string {
  const id = task.frontmatter.id ?? "UNKNOWN";

  const project = task.frontmatter.project ?? "UNKNOWN";

  const title = task.frontmatter.title ?? "UNKNOWN";

  return `
Kamu adalah worker dalam AI Office.

Kamu mendapatkan task berikut:

Task ID: ${id}
Project: ${project}
Judul: ${title}

Root AI Office:

${AI_OFFICE}

File task:

${task.path}

Ikuti instruksi berikut:

1. Baca file task terlebih dahulu.
2. Baca dokumentasi project yang relevan.
3. Baca System/Task-Protocol.md.
4. Pahami requirement task.
5. Pahami acceptance criteria.
6. Periksa dependency task.
7. Kerjakan pekerjaan sesuai scope task.
8. Jalankan test yang relevan.
9. Catat evidence hasil pekerjaan pada file task.
10. Jangan mengubah requirement secara diam-diam.
11. Jangan mengubah status menjadi DONE.
12. Jika implementation selesai, ubah status menjadi REVIEW.

Jangan meminta instruksi dari user.

File task adalah communication layer antara PM,
Orchestrator, worker, dan QA.

Kerjakan hanya pekerjaan yang termasuk scope task.
`.trim();
}

async function runWorker(task: Task, agent: Agent): Promise<void> {
  const taskId = task.frontmatter.id;

  if (!taskId) {
    return;
  }

  if (runningTasks.has(taskId)) {
    console.log(`[Orchestrator] ${taskId} sedang berjalan`);

    return;
  }

  runningTasks.add(taskId);

  try {
    console.log("");
    console.log("============================================================");
    console.log(`[Orchestrator] Menjalankan ${agent}`);
    console.log(`[Orchestrator] Task: ${taskId}`);
    console.log(`[Orchestrator] Judul: ${task.frontmatter.title ?? "-"}`);
    console.log("============================================================");

    const currentStatus = getTaskStatus(task);

    /*
     * Task baru:
     *
     * TODO -> IN-PROGRESS
     *
     * Task hasil QA:
     *
     * BLOCKED -> IN-PROGRESS
     */
    if (currentStatus === "todo") {
      task = await moveTaskToStatus(task, "in-progress");
    } else if (currentStatus === "blocked") {
      task = await moveTaskToStatus(task, "in-progress");
    }

    /*
     * Path task bisa berubah setelah dipindahkan,
     * jadi prompt dibuat setelah proses move.
     */
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
      `[Orchestrator] ${agent} selesai mengerjakan ${taskId} dengan exit code ${exitCode}`,
    );

    const latestTask = await readTask(task.path);

    const latestStatus = getTaskStatus(latestTask);

    /*
     * Worker gagal.
     *
     * Kalau masih IN-PROGRESS,
     * kembalikan ke TODO agar bisa
     * dicoba kembali.
     */
    if (exitCode !== 0) {
      if (latestStatus === "in-progress") {
        await moveTaskToStatus(latestTask, "todo");
      }

      console.error(`[Orchestrator] Worker gagal: ${taskId}`);

      return;
    }

    /*
     * Worker berhasil dan mengubah
     * status menjadi REVIEW.
     */
    if (latestStatus === "review") {
      await moveTaskToStatus(latestTask, "review");
    }
  } catch (error) {
    console.error(`[Orchestrator] Error worker ${taskId}`, error);

    try {
      const latestTask = await readTask(task.path);

      if (getTaskStatus(latestTask) === "in-progress") {
        await moveTaskToStatus(latestTask, "todo");
      }
    } catch {
      // Abaikan error sekunder.
    }
  } finally {
    runningTasks.delete(taskId);
  }
}

async function dispatchTasks(): Promise<void> {
  const rawTasks = await getTasks();

  /*
   * Pertama sinkronkan status dengan folder.
   */
  const tasks = await syncTaskLocations(rawTasks);

  for (const task of tasks) {
    const { id, status, assignee } = task.frontmatter;

    if (!id) {
      continue;
    }

    /*
     * Worker bisa mengambil:
     *
     * TODO
     * BLOCKED
     */
    if (status !== "todo" && status !== "blocked") {
      continue;
    }

    if (!isAgent(assignee)) {
      console.log(`[Orchestrator] ${id} dilewati: assignee tidak valid`);

      continue;
    }

    /*
     * QA punya dispatcher sendiri.
     */
    if (assignee === "QA") {
      continue;
    }

    const dependenciesDone = await areDependenciesDone(task, tasks);

    if (!dependenciesDone) {
      continue;
    }

    if (runningTasks.has(id)) {
      continue;
    }

    void runWorker(task, assignee);
  }
}

async function dispatchQA(): Promise<void> {
  const rawTasks = await getTasks();

  /*
   * Pastikan task REVIEW berada
   * di folder REVIEW terlebih dahulu.
   */
  const tasks = await syncTaskLocations(rawTasks);

  for (const task of tasks) {
    const { id, status, assignee } = task.frontmatter;

    if (!id) {
      continue;
    }

    if (status !== "review") {
      continue;
    }

    /*
     * QA hanya melakukan verification
     * terhadap implementation FE/BE.
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
      console.log("[Orchestrator] Menjalankan QA");
      console.log(`[Orchestrator] Task: ${id}`);
      console.log(
        "============================================================",
      );

      /*
       * REVIEW -> QA
       */
      const qaTask = await moveTaskToStatus(task, "qa");

      const prompt = `
Kamu adalah QA worker dalam AI Office.

Lakukan verification terhadap task berikut:

Task ID: ${id}
Project: ${qaTask.frontmatter.project ?? "UNKNOWN"}
Judul: ${qaTask.frontmatter.title ?? "UNKNOWN"}

File task:

${qaTask.path}

Root AI Office:

${AI_OFFICE}

Instruksi:

1. Baca file task.
2. Baca dokumentasi project yang relevan.
3. Baca System/Task-Protocol.md.
4. Periksa setiap acceptance criteria.
5. Periksa evidence implementation.
6. Jalankan test yang relevan.
7. Test happy path.
8. Test edge case yang penting.
9. Periksa error handling.
10. Periksa kemungkinan regression jika relevan.
11. Catat evidence hasil QA pada file task.

Jika PASS:

- ubah status menjadi DONE

Jika FAIL:

- ubah status menjadi BLOCKED
- jelaskan defect dengan jelas
- sertakan evidence yang bisa direproduksi

Jangan mengubah requirement secara diam-diam.
Jangan meminta instruksi dari user.
Jangan mengimplementasikan feature.
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
        `[Orchestrator] QA selesai ${id} dengan exit code ${exitCode}`,
      );

      const latestTask = await readTask(qaTask.path);

      const latestStatus = getTaskStatus(latestTask);

      /*
       * Kalau QA process crash/error
       * dan task masih QA, kembalikan
       * ke REVIEW agar tidak hilang.
       */
      if (exitCode !== 0) {
        if (latestStatus === "qa") {
          await moveTaskToStatus(latestTask, "review");
        }

        return;
      }

      /*
       * QA PASS
       *
       * QA -> DONE
       */
      if (latestStatus === "done") {
        await moveTaskToStatus(latestTask, "done");
      }

      /*
       * QA FAIL
       *
       * QA -> BLOCKED
       */
      if (latestStatus === "blocked") {
        await moveTaskToStatus(latestTask, "blocked");
      }
    } catch (error) {
      console.error(`[Orchestrator] Error QA ${id}`, error);
    } finally {
      runningTasks.delete(id);
    }
  }
}

async function tick(): Promise<void> {
  try {
    await ensureDirectories();

    /*
     * Dispatch FE / BE.
     */
    await dispatchTasks();

    /*
     * Dispatch QA.
     */
    await dispatchQA();
  } catch (error) {
    console.error("[Orchestrator] Error pada tick:", error);
  }
}

async function main(): Promise<void> {
  console.log("");
  console.log("============================================================");
  console.log("                 AI OFFICE ORCHESTRATOR");
  console.log("============================================================");
  console.log(`AI Office : ${AI_OFFICE}`);
  console.log(`Tasks     : ${TASKS_DIR}`);
  console.log(`Polling   : ${POLL_INTERVAL}ms`);
  console.log("============================================================");
  console.log("");

  await ensureDirectories();

  /*
   * Jalankan sekali langsung.
   */
  await tick();

  /*
   * Setelah itu polling setiap 5 detik.
   */
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL);
}

void main();
