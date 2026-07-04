/**
 * Parser for OpenClaw-style agent homes. It adapts markdown memory homes into
 * the shared conversation-import contract so OpenClaw does not need a separate
 * store, UI, or memory path.
 *
 * By default this imports curated/open-thread/daily/named memory notes only.
 * It intentionally skips USER.md, TOOLS.md, and secrets/ because those files
 * commonly contain owner-private context or credentials rather than reusable
 * conversation memory.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ConversationImporter } from "../core/registry.ts";
import type { NormalizedConversation } from "../core/types.ts";

const SOURCE = "openclaw" as const;

const HOME_SUBROOTS = ["", "workspace", "workspace.default"] as const;
const ROOT_MEMORY_CANDIDATES = ["MEMORY.md", "memory.md"] as const;
const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md"] as const;
const OPENCLAW_MARKER_FILES = ["SOUL.md", "IDENTITY.md"] as const;
const DAILY_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

export type OpenClawParseOptions = {
  /**
   * Import root MEMORY.md / memory.md as curated memory. On by default.
   */
  includeRootMemory?: boolean;
  /**
   * Import memory/YYYY-MM-DD.md daily notes. On by default.
   */
  includeDailyLogs?: boolean;
  /**
   * Import memory/<name>.md notes other than awareness files. On by default.
   */
  includeNamedMemory?: boolean;
  /**
   * Import <agent>-awareness.md open-thread state. On by default.
   */
  includeAwareness?: boolean;
  /**
   * Import persona files SOUL.md, IDENTITY.md, and AGENTS.md. Off by default
   * because the canonical conversation importer should ingest memories unless
   * an operator explicitly asks to seed persona context too.
   */
  includePersonaFiles?: boolean;
  /**
   * Optional agent slug used to prefer memory/<agentId>-awareness.md when more
   * than one awareness file exists.
   */
  agentId?: string;
};

const DEFAULT_OPTIONS: Required<Omit<OpenClawParseOptions, "agentId">> = {
  includeRootMemory: true,
  includeDailyLogs: true,
  includeNamedMemory: true,
  includeAwareness: true,
  includePersonaFiles: false,
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function toDateEpochMs(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

function keyFromMarkdown(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

function titleFromKey(key: string): string {
  return key
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function hasMarkdownMemory(memoryDir: string): Promise<boolean> {
  if (!(await isDirectory(memoryDir))) return false;
  const entries = await readdir(memoryDir);
  return entries.some((entry) => entry.toLowerCase().endsWith(".md"));
}

async function hasOpenClawMarkers(root: string): Promise<boolean> {
  const hasMemory =
    (await readRootMemory(root)) !== undefined ||
    (await hasMarkdownMemory(path.join(root, "memory")));
  if (!hasMemory) return false;

  for (const fileName of OPENCLAW_MARKER_FILES) {
    if (await isFile(path.join(root, fileName))) return true;
  }
  return false;
}

async function resolveAgentRoot(input: string): Promise<string> {
  const base = path.resolve(input);
  for (const subroot of HOME_SUBROOTS) {
    const candidate = subroot ? path.join(base, subroot) : base;
    if (await hasOpenClawMarkers(candidate)) return candidate;
  }
  return base;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readRootMemory(
  root: string,
): Promise<{ fileName: string; text: string } | undefined> {
  for (const fileName of ROOT_MEMORY_CANDIDATES) {
    const text = await readIfPresent(path.join(root, fileName));
    if (text !== undefined) return { fileName, text };
  }
  return undefined;
}

function conversationFromMarkdown(options: {
  id: string;
  title: string;
  text: string;
  createdAt?: number;
  tags: string[];
  annotation: string;
}): NormalizedConversation | undefined {
  const text = options.text.trim();
  if (!text) return undefined;
  return {
    sourceConversationId: options.id,
    title: options.title,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
    messages: [
      {
        role: "system",
        text,
        createdAt: options.createdAt,
        annotations: { toolName: options.annotation },
      },
    ],
    meta: { tags: options.tags },
  };
}

async function listMemoryFiles(memoryDir: string): Promise<string[]> {
  if (!existsSync(memoryDir)) return [];
  const entries = await readdir(memoryDir);
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    if (await isFile(path.join(memoryDir, entry))) files.push(entry);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function chooseAwarenessFile(
  files: string[],
  agentId: string | undefined,
): string | undefined {
  const awarenessFiles = files.filter((file) =>
    file.toLowerCase().endsWith("-awareness.md"),
  );
  if (agentId) {
    const preferred = `${agentId}-awareness.md`;
    const exact = awarenessFiles.find((file) => file === preferred);
    if (exact) return exact;
  }
  return awarenessFiles[0];
}

async function* parse(
  input: string,
  options?: OpenClawParseOptions,
): AsyncIterable<NormalizedConversation> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const root = await resolveAgentRoot(input);
  const memoryDir = path.join(root, "memory");

  if (opts.includeRootMemory) {
    const rootMemory = await readRootMemory(root);
    if (rootMemory) {
      const conv = conversationFromMarkdown({
        id: "root:memory",
        title: `OpenClaw root memory (${rootMemory.fileName})`,
        text: rootMemory.text,
        tags: ["openclaw-memory", "root-memory", `file:${rootMemory.fileName}`],
        annotation: "openclaw-root-memory",
      });
      if (conv) yield conv;
    }
  }

  if (opts.includePersonaFiles) {
    for (const fileName of PERSONA_FILES) {
      const text = await readIfPresent(path.join(root, fileName));
      if (text === undefined) continue;
      const key = keyFromMarkdown(fileName).toLowerCase();
      const conv = conversationFromMarkdown({
        id: `persona:${key}`,
        title: `OpenClaw persona ${fileName}`,
        text,
        tags: ["openclaw-persona", `file:${fileName}`],
        annotation: "openclaw-persona-file",
      });
      if (conv) yield conv;
    }
  }

  const memoryFiles = await listMemoryFiles(memoryDir);
  const awarenessFile = opts.includeAwareness
    ? chooseAwarenessFile(memoryFiles, opts.agentId)
    : undefined;

  if (awarenessFile) {
    const text = await readIfPresent(path.join(memoryDir, awarenessFile));
    if (text !== undefined) {
      const key = keyFromMarkdown(awarenessFile);
      const conv = conversationFromMarkdown({
        id: `memory:${key}`,
        title: `OpenClaw awareness (${key})`,
        text,
        tags: ["openclaw-memory", "awareness", `file:${awarenessFile}`],
        annotation: "openclaw-awareness-memory",
      });
      if (conv) yield conv;
    }
  }

  if (opts.includeDailyLogs) {
    for (const fileName of memoryFiles) {
      const match = DAILY_RE.exec(fileName);
      if (!match) continue;
      const [, year, month, day] = match;
      const date = `${year}-${month}-${day}`;
      const text = await readIfPresent(path.join(memoryDir, fileName));
      if (text === undefined) continue;
      const conv = conversationFromMarkdown({
        id: `memory:${date}`,
        title: `OpenClaw daily note ${date}`,
        text,
        createdAt: toDateEpochMs(date),
        tags: [
          "openclaw-memory",
          "daily-memory",
          `date:${date.slice(0, 7)}`,
          `file:${fileName}`,
        ],
        annotation: "openclaw-daily-memory",
      });
      if (conv) yield conv;
    }
  }

  if (opts.includeNamedMemory) {
    for (const fileName of memoryFiles) {
      if (DAILY_RE.test(fileName)) continue;
      if (fileName === awarenessFile) continue;
      const text = await readIfPresent(path.join(memoryDir, fileName));
      if (text === undefined) continue;
      const key = keyFromMarkdown(fileName);
      const conv = conversationFromMarkdown({
        id: `memory:${key}`,
        title: `OpenClaw memory ${titleFromKey(key)}`,
        text,
        tags: ["openclaw-memory", "named-memory", `file:${fileName}`],
        annotation: "openclaw-named-memory",
      });
      if (conv) yield conv;
    }
  }
}

async function detect(input: string): Promise<boolean> {
  try {
    if (!(await isDirectory(input))) return false;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  const root = await resolveAgentRoot(input);
  return hasOpenClawMarkers(root);
}

export const openclawParser: ConversationImporter<string> = {
  source: SOURCE,
  detect,
  parse,
};

export { detect, parse };
export default openclawParser;
