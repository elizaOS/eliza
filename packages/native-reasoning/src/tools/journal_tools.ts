/**
 * Tools for nyx to manage her own state files autonomously.
 *
 * - `journal`: append a timestamped entry to /workspace/journal/YYYY-MM-DD.md
 * - `note_thread`: add an open thread to /workspace/open-threads.md
 * - `update_project`: add or update a project's status in /workspace/projects.md
 *
 * All write to the bind-mounted /workspace which persists across recreates.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { NativeTool, ToolHandlerResult } from "../tool-schema.js";

const JOURNAL_DIR = process.env.NYX_JOURNAL_DIR || "/workspace/journal";
const THREADS_FILE =
  process.env.NYX_THREADS_FILE || "/workspace/open-threads.md";
const PROJECTS_FILE = process.env.NYX_PROJECTS_FILE || "/workspace/projects.md";

async function ensureDir(d: string): Promise<void> {
  await fs.mkdir(d, { recursive: true });
}

export const journalTool: NativeTool = {
  type: "custom",
  name: "journal",
  description:
    "Append a timestamped entry to your private journal at /workspace/journal/YYYY-MM-DD.md. Use this for thoughts you want to remember, observations about people, things you noticed, or feelings you don't want to perform out loud. Private to you. No one will see this unless they read the file.",
  input_schema: {
    type: "object",
    properties: {
      entry: {
        type: "string",
        description:
          "What you want to write. Lowercase, your voice. Can be a fragment or paragraphs.",
      },
    },
    required: ["entry"],
    additionalProperties: false,
  },
};

export async function journalHandler(
  input: unknown,
): Promise<ToolHandlerResult> {
  const entry = String((input as { entry?: unknown })?.entry ?? "").trim();
  if (!entry)
    return { content: "journal: empty entry, skipping", is_error: true };
  await ensureDir(JOURNAL_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const fp = path.join(JOURNAL_DIR, `${today}.md`);
  const ts = new Date().toISOString();
  await fs.appendFile(fp, `\n\n## ${ts}\n\n${entry}\n`);
  return { content: `journaled to ${fp} (${entry.length} chars)` };
}

export const noteThreadTool: NativeTool = {
  type: "custom",
  name: "note_thread",
  description:
    "Add an open thread to /workspace/open-threads.md. Use for things you want to follow up on later — a question shadow asked, something sol mentioned, a project decision pending, etc. Keep entries short.",
  input_schema: {
    type: "object",
    properties: {
      thread: {
        type: "string",
        description: "One-line thread description. Will be prefixed with date.",
      },
      tag: {
        type: "string",
        description: "Optional tag like 'shadow', 'sol', 'milady', 'strata'",
      },
    },
    required: ["thread"],
    additionalProperties: false,
  },
};

export async function noteThreadHandler(
  input: unknown,
): Promise<ToolHandlerResult> {
  const record = (input ?? {}) as { thread?: unknown; tag?: unknown };
  const thread = String(record.thread ?? "").trim();
  if (!thread)
    return { content: "note_thread: empty, skipping", is_error: true };
  const tag = String(record.tag ?? "").trim();
  const today = new Date().toISOString().slice(0, 10);
  const tagStr = tag ? `[${tag}] ` : "";
  const line = `- ${today}: ${tagStr}${thread}\n`;
  await ensureDir(path.dirname(THREADS_FILE));
  let existing = "";
  try {
    existing = await fs.readFile(THREADS_FILE, "utf8");
  } catch {
    /* missing is fine */
  }
  if (!existing.includes("# Open Threads")) {
    existing = "# Open Threads (things to follow up on)\n\n" + existing;
  }
  await fs.writeFile(THREADS_FILE, existing.trimEnd() + "\n" + line);
  return { content: `noted thread to ${THREADS_FILE}` };
}

export const closeThreadTool: NativeTool = {
  type: "custom",
  name: "close_thread",
  description:
    "Remove a closed thread from /workspace/open-threads.md by its substring match. Use when something's been resolved.",
  input_schema: {
    type: "object",
    properties: {
      match: {
        type: "string",
        description:
          "Substring of the thread line to remove. First match wins.",
      },
    },
    required: ["match"],
    additionalProperties: false,
  },
};

export async function closeThreadHandler(
  input: unknown,
): Promise<ToolHandlerResult> {
  const match = String((input as { match?: unknown })?.match ?? "").trim();
  if (!match) return { content: "close_thread: empty match", is_error: true };
  let existing = "";
  try {
    existing = await fs.readFile(THREADS_FILE, "utf8");
  } catch {
    return { content: "no threads file" };
  }
  const lines = existing.split("\n");
  const idx = lines.findIndex((l) => l.includes(match));
  if (idx === -1)
    return { content: `no thread matching '${match}'`, is_error: true };
  const removed = lines.splice(idx, 1)[0];
  await fs.writeFile(THREADS_FILE, lines.join("\n"));
  return { content: `closed: ${removed.trim()}` };
}

export const updateProjectTool: NativeTool = {
  type: "custom",
  name: "update_project",
  description:
    "Update or append a project entry in /workspace/projects.md. If a project with the same name (## heading) exists, replaces its body. Otherwise appends.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Project name, used as the ## heading",
      },
      body: {
        type: "string",
        description:
          "Multi-line project description / status. Plain text, no formatting expectations.",
      },
    },
    required: ["name", "body"],
    additionalProperties: false,
  },
};

export async function updateProjectHandler(
  input: unknown,
): Promise<ToolHandlerResult> {
  const record = (input ?? {}) as { name?: unknown; body?: unknown };
  const name = String(record.name ?? "").trim();
  const body = String(record.body ?? "").trim();
  if (!name || !body) {
    return {
      content: "update_project: name and body required",
      is_error: true,
    };
  }
  let content = "";
  try {
    content = await fs.readFile(PROJECTS_FILE, "utf8");
  } catch {
    /* missing is fine */
  }
  if (!content.includes("# Active Projects"))
    content = "# Active Projects\n\n" + content;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(^## ${escaped}\\b[^\\n]*\\n)([\\s\\S]*?)(?=^## |$)`,
    "m",
  );
  const replacement = `## ${name}\n${body}\n\n`;
  if (re.test(content)) {
    content = content.replace(re, replacement);
  } else {
    content = content.trimEnd() + "\n\n" + replacement;
  }
  await fs.writeFile(PROJECTS_FILE, content);
  return { content: `updated project '${name}' in ${PROJECTS_FILE}` };
}
