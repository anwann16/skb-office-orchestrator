import { load } from "js-yaml";
import { readFile } from "node:fs/promises";

import type { Task, TaskFrontmatter } from "../types";

export async function readTask(filePath: string): Promise<Task> {
  const content = await readFile(filePath, "utf8");

  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);

  if (!match) {
    throw new Error(`Task tidak memiliki YAML frontmatter: ${filePath}`);
  }

  const frontmatter = load(match[1] ?? "") as TaskFrontmatter;

  if (!frontmatter.id) {
    throw new Error(`Task tidak memiliki id: ${filePath}`);
  }

  return {
    ...frontmatter,
    filePath,
    content,
  };
}
