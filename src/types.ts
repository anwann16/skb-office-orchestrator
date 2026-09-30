export type Agent = "FE" | "BE" | "QA";

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in-progress"
  | "review"
  | "qa"
  | "blocked"
  | "done";

export interface TaskFrontmatter {
  id: string;
  project: string;
  title: string;
  type: string;
  priority: string;
  status: TaskStatus;
  assignee: Agent | string;
  depends_on: string[];
  created_by: string;
  created_at?: string;
  updated_at?: string;
}

export interface Task extends TaskFrontmatter {
  filePath: string;
  content: string;
}

export interface WorkerResult {
  taskId: string;
  agent: Agent;
  exitCode: number;
}
