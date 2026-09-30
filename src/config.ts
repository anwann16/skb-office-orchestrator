import os from "node:os";
import path from "node:path";

export const AI_OFFICE = path.join(
  os.homedir(),
  "notes-brain",
  "Skb-Ai-Office",
);

export const TASKS_DIR = path.join(AI_OFFICE, "Tasks");

export const PROJECTS_DIR = path.join(AI_OFFICE, "Projects");

export const SYSTEM_DIR = path.join(AI_OFFICE, "System");

export const TEMPLATES_DIR = path.join(AI_OFFICE, "Templates");

export const POLL_INTERVAL_MS = 5000;

export const STATUS_FOLDERS = {
  backlog: "BACKLOG",
  todo: "TODO",
  "in-progress": "IN-PROGRESS",
  review: "REVIEW",
  qa: "QA",
  blocked: "BLOCKED",
  done: "DONE",
} as const;
