import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as elizaCore from "@elizaos/core";
import { resolveUserPath } from "../config/paths";

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a command with an optional timeout.
 * Returns { code, stdout, stderr }.
 * Rejects if the process cannot be spawned or the timeout fires.
 */
export function runCommandWithTimeout(
  argv: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const [cmd, ...args] = argv;
  if (!cmd) {
    return Promise.reject(new Error("runCommandWithTimeout: empty argv"));
  }

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(
            `Command timed out after ${opts.timeoutMs}ms: ${argv.join(" ")}`,
          ),
        );
        return;
      }

      resolve({
        code: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const profile = env.MILADY_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(homedir(), ".milady", `workspace-${profile}`);
  }
  return path.join(homedir(), ".milady", "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
const DEFAULT_USER_FILENAME = "USER.md";
const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

/** Inline workspace bootstrap templates — no external files needed. */
const WORKSPACE_TEMPLATES: Record<string, string> = {
  [DEFAULT_AGENTS_FILENAME]: `# Agents

You are an autonomous AI agent powered by elizaOS.

## Capabilities

- Respond to user messages conversationally
- Execute actions and use available tools
- Access and manage knowledge from your workspace
- Maintain context across conversations

## Guidelines

- Be helpful, concise, and accurate
- Ask for clarification when instructions are ambiguous
- Use tools when they would help accomplish the user's goal
- Respect the user's preferences and communication style
`,
  [DEFAULT_TOOLS_FILENAME]: `# Tools

Available tools and capabilities for the agent.

## Built-in Tools

The agent has access to tools provided by enabled plugins.
Each plugin may register actions, providers, and evaluators
that extend the agent's capabilities.

## Usage

Tools are invoked automatically when the agent determines
they would help accomplish the user's goal. No manual
configuration is required.
`,
  [DEFAULT_IDENTITY_FILENAME]: `# Identity

Your character and personality settings.

Customize this file to define your agent's personality,
tone, and behavior style.
`,
  [DEFAULT_USER_FILENAME]: `# User

User context and preferences.

This file stores information about the user to help
personalize interactions.
`,
  [DEFAULT_HEARTBEAT_FILENAME]: `# Heartbeat

The heartbeat system enables autonomous agent behavior.

## Scheduling

When autonomy is enabled, the agent periodically evaluates
whether to take proactive actions based on its goals,
pending tasks, and environmental changes.

## Triggers

- Scheduled intervals (configurable)
- External events from connected channels
- System notifications and alerts
`,
  [DEFAULT_BOOTSTRAP_FILENAME]: `# Bootstrap

Initial workspace setup for a new agent.

## Getting Started

This workspace was automatically created for your agent.
You can customize it by editing the markdown files in this
directory:

- **AGENTS.md** — Agent behavior and capabilities
- **TOOLS.md** — Available tools and plugins
- **IDENTITY.md** — Character and personality
- **USER.md** — User context and preferences
- **HEARTBEAT.md** — Autonomous behavior settings

## Configuration

Agent configuration is managed through \`~/.milady/milady.json\`
or the Milady Control UI.
`,
};

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

type ElizaCoreWorkspaceHelpers = {
  isSubagentSessionKey?: (key: string) => boolean;
  logger?: {
    warn: (message: string) => void;
  };
};

const coreWorkspaceHelpers = elizaCore as ElizaCoreWorkspaceHelpers;

function isSubagentSessionKey(sessionKey: string): boolean {
  if (typeof coreWorkspaceHelpers.isSubagentSessionKey === "function") {
    return coreWorkspaceHelpers.isSubagentSessionKey(sessionKey);
  }
  // Older @elizaos/core versions do not expose subagent helpers.
  // Treat all sessions as primary sessions in that case.
  return false;
}

function logWarn(message: string): void {
  if (
    coreWorkspaceHelpers.logger &&
    typeof coreWorkspaceHelpers.logger.warn === "function"
  ) {
    coreWorkspaceHelpers.logger.warn(message);
    return;
  }
  console.warn(message);
}

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["git", "--version"], {
      timeoutMs: 2_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], {
      cwd: dir,
      timeoutMs: 10_000,
    });
  } catch (err) {
    logWarn(
      `[workspace] git init failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim()
    ? params.dir.trim()
    : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);

  const isBrandNewWorkspace = await (async () => {
    const paths = [
      agentsPath,
      toolsPath,
      identityPath,
      userPath,
      heartbeatPath,
    ];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
          }
          throw err;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  const agentsTemplate = WORKSPACE_TEMPLATES[DEFAULT_AGENTS_FILENAME];
  const toolsTemplate = WORKSPACE_TEMPLATES[DEFAULT_TOOLS_FILENAME];
  const identityTemplate = WORKSPACE_TEMPLATES[DEFAULT_IDENTITY_FILENAME];
  const userTemplate = WORKSPACE_TEMPLATES[DEFAULT_USER_FILENAME];
  const heartbeatTemplate = WORKSPACE_TEMPLATES[DEFAULT_HEARTBEAT_FILENAME];
  const bootstrapTemplate = WORKSPACE_TEMPLATES[DEFAULT_BOOTSTRAP_FILENAME];

  const writeOps = [
    writeFileIfMissing(agentsPath, agentsTemplate),
    writeFileIfMissing(toolsPath, toolsTemplate),
    writeFileIfMissing(identityPath, identityTemplate),
    writeFileIfMissing(userPath, userTemplate),
    writeFileIfMissing(heartbeatPath, heartbeatTemplate),
  ];
  if (isBrandNewWorkspace) {
    writeOps.push(writeFileIfMissing(bootstrapPath, bootstrapTemplate));
  }
  await Promise.all(writeOps);
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

async function resolveMemoryBootstrapEntries(
  resolvedDir: string,
): Promise<Array<{ name: WorkspaceBootstrapFileName; filePath: string }>> {
  const candidates: WorkspaceBootstrapFileName[] = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ];
  const entries: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> =
    [];
  for (const name of candidates) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      entries.push({ name, filePath });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (entries.length <= 1) {
    return entries;
  }

  const seen = new Set<string>();
  const deduped: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> =
    [];
  for (const entry of entries) {
    let key = entry.filePath;
    try {
      key = await fs.realpath(entry.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export async function loadWorkspaceBootstrapFiles(
  dir: string,
): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));

  const result = await Promise.all(
    entries.map(async (entry): Promise<WorkspaceBootstrapFile> => {
      try {
        const content = await fs.readFile(entry.filePath, "utf-8");
        return {
          name: entry.name,
          path: entry.filePath,
          content,
          missing: false,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { name: entry.name, path: entry.filePath, missing: true };
        }
        throw err;
      }
    }),
  );
  return result;
}

const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || !isSubagentSessionKey(sessionKey)) {
    return files;
  }
  return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
}
