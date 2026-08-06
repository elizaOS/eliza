import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { DelegationRun, DelegationStatus, TaskRequest, ToolResult } from "../types/index";
import { getHomeDir, type SandboxMode, type SandboxSettings } from "../utils/settings";

const ID_ADJECTIVES = ["brisk", "calm", "clever", "eager", "gentle", "keen", "lively", "nimble", "quiet", "steady"];

const ID_COLORS = ["amber", "blue", "copper", "emerald", "indigo", "ivory", "silver", "teal", "violet", "white"];

const ID_ANIMALS = ["badger", "falcon", "fox", "heron", "lynx", "otter", "owl", "panda", "sparrow", "wolf"];

export interface StoredDelegation {
  id: string;
  agent: "explore";
  description: string;
  prompt: string;
  cwd: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds: number;
  maxTokens: number;
  batchApi?: boolean;
  status: DelegationStatus;
  startedAt: string;
  completedAt?: string;
  pid?: number;
  error?: string;
  title?: string;
  summary?: string;
  outputPath: string;
  notifiedAt?: string;
}

export interface DelegationNotification {
  id: string;
  message: string;
}

interface StartDelegationOptions {
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds: number;
  maxTokens: number;
  batchApi?: boolean;
}

export class DelegationManager {
  constructor(private readonly getCwd: () => string) {}

  async start(request: TaskRequest, options: StartDelegationOptions): Promise<ToolResult> {
    if (process.env.CLAWD_BACKGROUND_CHILD === "1") {
      return {
        success: false,
        output: "Nested background delegations are disabled.",
      };
    }

    if (request.agent !== "explore") {
      return {
        success: false,
        output:
          "Background delegations are read-only. Use `delegate` with the `explore` agent, or use `task` for foreground work that may edit files.",
      };
    }

    const cwd = this.getCwd();
    const dir = await ensureDelegationsDir(cwd);
    const id = await generateUniqueId(dir);
    const outputPath = path.join(dir, `${id}.md`);
    const jobPath = path.join(dir, `${id}.json`);

    const record: StoredDelegation = {
      id,
      agent: "explore",
      description: request.description,
      prompt: request.prompt,
      cwd,
      model: options.model,
      sandboxMode: options.sandboxMode,
      sandboxSettings: options.sandboxSettings,
      maxToolRounds: options.maxToolRounds,
      maxTokens: options.maxTokens,
      batchApi: options.batchApi,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath,
    };

    await writeRecord(jobPath, record);

    const child = spawn(
      process.execPath,
      [
        ...resolveCliArgs(),
        "--directory",
        cwd,
        "--background-task-file",
        jobPath,
        ...(options.batchApi ? ["--batch-api"] : []),
      ],
      {
        cwd,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CLAWD_BACKGROUND_CHILD: "1" },
      },
    );
    child.unref();

    record.pid = child.pid;
    await writeRecord(jobPath, record);

    const output = [
      `Delegation started: ${id}`,
      "Agent: explore",
      "You will be notified when it completes.",
      `Use \`delegation_read("${id}")\` to retrieve the full result later.`,
    ].join("\n");

    return {
      success: true,
      output,
      delegation: {
        id,
        agent: "explore",
        description: request.description,
        summary: "Running in the background.",
        status: "running",
      },
    };
  }

  async list(): Promise<DelegationRun[]> {
    const dir = await ensureDelegationsDir(this.getCwd());
    const files = await readDelegationFiles(dir);
    const items = await Promise.all(files.map(async (file) => readRecord(path.join(dir, file))));

    return items
      .filter((item): item is StoredDelegation => item !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(toDelegationRun);
  }

  async read(id: string): Promise<string> {
    const record = await this.getById(id);
    if (!record) {
      return `Delegation "${id}" not found. Use \`delegation_list()\` to see available results.`;
    }

    if (record.status === "running") {
      return `Delegation "${id}" is still running. Continue working and wait for the completion notice.`;
    }

    try {
      return await fs.readFile(record.outputPath, "utf8");
    } catch {
      if (record.error) {
        return `Delegation "${id}" failed.\n\n${record.error}`;
      }
      return `Delegation "${id}" completed, but its saved output could not be read.`;
    }
  }

  async consumeNotifications(): Promise<DelegationNotification[]> {
    const dir = await ensureDelegationsDir(this.getCwd());
    const files = await readDelegationFiles(dir);
    const notifications: DelegationNotification[] = [];

    for (const file of files) {
      const jobPath = path.join(dir, file);
      const record = await readRecord(jobPath);
      if (!record || record.status === "running" || record.notifiedAt) continue;

      record.notifiedAt = new Date().toISOString();
      await writeRecord(jobPath, record);
      notifications.push({
        id: record.id,
        message: formatNotification(record),
      });
    }

    return notifications.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async getById(id: string): Promise<StoredDelegation | null> {
    const dir = await ensureDelegationsDir(this.getCwd());
    return readRecord(path.join(dir, `${id}.json`));
  }
}

export async function loadDelegation(jobPath: string): Promise<StoredDelegation> {
  const record = await readRecord(jobPath);
  if (!record) {
    throw new Error(`Delegation job not found: ${jobPath}`);
  }
  return record;
}

export async function completeDelegation(jobPath: string, output: string, fallbackSummary?: string): Promise<void> {
  const record = await loadDelegation(jobPath);
  record.status = "complete";
  record.completedAt = new Date().toISOString();
  record.title = record.title || createTitle(output, record.description);
  record.summary = createSummary(output || fallbackSummary || record.description);

  await fs.mkdir(path.dirname(record.outputPath), { recursive: true });
  await fs.writeFile(record.outputPath, renderOutput(record, output), "utf8");
  await writeRecord(jobPath, record);
}

export async function failDelegation(jobPath: string, error: string, output = ""): Promise<void> {
  const record = await loadDelegation(jobPath);
  record.status = "error";
  record.completedAt = new Date().toISOString();
  record.error = error;
  record.title = record.title || createTitle(output || error, record.description);
  record.summary = createSummary(output || error);

  await fs.mkdir(path.dirname(record.outputPath), { recursive: true });
  await fs.writeFile(record.outputPath, renderOutput(record, output || `Error: ${error}`), "utf8");
  await writeRecord(jobPath, record);
}

async function ensureDelegationsDir(cwd: string): Promise<string> {
  const projectId = getProjectId(cwd);
  const dir = path.join(getHomeDir(), ".grok", "delegations", projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readDelegationFiles(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readRecord(filePath: string): Promise<StoredDelegation | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StoredDelegation;
  } catch {
    return null;
  }
}

async function writeRecord(filePath: string, record: StoredDelegation): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
}

async function generateUniqueId(dir: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomId();
    try {
      await fs.access(path.join(dir, `${id}.json`));
    } catch {
      return id;
    }
  }

  throw new Error("Failed to allocate a unique delegation ID.");
}

function randomId(): string {
  return `${pick(ID_ADJECTIVES)}-${pick(ID_COLORS)}-${pick(ID_ANIMALS)}`;
}

function pick(values: readonly string[]): string {
  return values[Math.floor(Math.random() * values.length)];
}

function resolveCliArgs(): string[] {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Could not resolve the CLI entrypoint for background delegation.");
  }
  return [entry];
}

function getProjectId(cwd: string): string {
  const base =
    path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

function createTitle(text: string, fallback: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const source = firstLine || fallback.trim() || "Background delegation";
  return source.length <= 48 ? source : `${source.slice(0, 45).trimEnd()}...`;
}

function createSummary(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No summary available.";
  return compact.length <= 180 ? compact : `${compact.slice(0, 177).trimEnd()}...`;
}

function renderOutput(record: StoredDelegation, content: string): string {
  const title = record.title || record.id;
  const summary = record.summary || "No summary available.";
  const completed = record.completedAt || "N/A";
  const error = record.error ? `\n**Error:** ${record.error}\n` : "";

  return [
    `# ${title}`,
    "",
    summary,
    "",
    `**ID:** ${record.id}`,
    `**Agent:** ${record.agent}`,
    `**Status:** ${record.status}`,
    `**Started:** ${record.startedAt}`,
    `**Completed:** ${completed}`,
    "",
    `**Prompt:** ${record.description}`,
    error.trimEnd(),
    "",
    "---",
    "",
    content.trim() || "(No output)",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNotification(record: StoredDelegation): string {
  const title = record.title || record.description || record.id;
  const summary = record.summary || (record.error ? createSummary(record.error) : "No summary available.");
  const statusText = record.status === "complete" ? "complete" : "failed";
  const lines = [`Background agent ${statusText}: \`${record.id}\``, `Title: ${title}`, `Summary: ${summary}`];

  if (record.error) {
    lines.push(`Error: ${record.error}`);
  }

  lines.push(`Use \`delegation_read("${record.id}")\` to retrieve the full result.`);
  return lines.join("\n");
}

function toDelegationRun(record: StoredDelegation): DelegationRun {
  return {
    id: record.id,
    agent: "explore",
    description: record.description,
    summary: record.summary || (record.status === "running" ? "Running in the background." : "No summary available."),
    status: record.status,
  };
}
