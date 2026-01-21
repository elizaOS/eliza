import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentOrchestratorService as CodeTaskService } from "@elizaos/plugin-agent-orchestrator";
import { initializeAgent, shutdownAgent } from "../lib/agent.js";
import { setCwd } from "../lib/cwd.js";
import type { SubAgentType } from "../types.js";

type RunResult = {
  type: SubAgentType;
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
};

const execFileAsync = promisify(execFile);

function nowIso(): string {
  return new Date().toISOString();
}

function logLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function git(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: opts?.cwd,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { stdout: "", stderr: e.message, exitCode: 1 };
  }
}

async function getRepoRoot(startDir: string): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], { cwd: startDir });
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    throw new Error(`Not a git repository: ${r.stderr || startDir}`);
  }
  return r.stdout.trim();
}

async function createDetachedWorktree(repoRoot: string): Promise<string> {
  const rand = crypto.randomBytes(6).toString("hex");
  const dir = path.join(
    repoRoot,
    ".eliza",
    "e2e-worktrees",
    `${Date.now()}-${rand}`,
  );
  const add = await git(["worktree", "add", "--detach", dir, "HEAD"], {
    cwd: repoRoot,
  });
  if (add.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr}`);
  }
  return dir;
}

async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  // Use --force because tasks might have created untracked files; we want cleanup.
  await git(["worktree", "remove", "--force", dir], { cwd: repoRoot });
  await git(["worktree", "prune"], { cwd: repoRoot });
}

async function gitStatusPorcelain(cwd: string): Promise<string> {
  const r = await git(["status", "--porcelain"], { cwd });
  if (r.exitCode !== 0) return "(git status failed)";
  return r.stdout.trim();
}

async function runOne(
  service: CodeTaskService,
  type: SubAgentType,
): Promise<RunResult> {
  const task = await service.createCodeTask(
    `E2E: ${type}`,
    [
      `E2E sanity check for sub-agent "${type}".`,
      "",
      "Requirements:",
      "- Run a simple, safe command to confirm the environment (e.g. `pwd` and `git status --porcelain`).",
      "- Do NOT modify files.",
      "- Return DONE with a short summary of what you verified.",
    ].join("\n"),
    undefined,
    type,
  );

  const taskId = task.id ?? "";
  if (!taskId) {
    throw new Error(`Failed to create task for ${type}`);
  }

  logLine(`[${nowIso()}] starting ${type} task ${taskId}`);
  await service.startTaskExecution(taskId);

  const finished = await service.getTask(taskId);
  const status = finished?.metadata.status;
  const result = finished?.metadata.result;

  if (!finished || !status || !result) {
    return {
      type,
      taskId,
      status: "failed",
      summary: "Missing task metadata after execution",
    };
  }

  if (status === "completed") {
    return { type, taskId, status, summary: result.summary };
  }
  if (status === "cancelled") {
    return { type, taskId, status, summary: result.summary };
  }

  return {
    type,
    taskId,
    status: "failed",
    summary: result.error ?? result.summary,
  };
}

function getRunnableTypes(): SubAgentType[] {
  // SDK workers require provider-specific API keys; still include them, but skip
  // when keys are missing so this script can run in a local environment without
  // configuring every provider.
  const types: SubAgentType[] = [
    "eliza",
    "elizaos-native",
    "opencode",
    "sweagent",
    "codex",
    "claude-code",
  ];

  const openai = process.env.OPENAI_API_KEY?.trim();
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  const provider = (process.env.ELIZA_CODE_PROVIDER ?? "").trim().toLowerCase();

  return types.filter((t) => {
    if (t === "codex") return Boolean(openai);
    if (t === "claude-code") return Boolean(anthropic);

    // If a provider is explicitly selected, require that key for runtime-based workers too.
    if (provider === "openai") return Boolean(openai);
    if (provider === "anthropic") return Boolean(anthropic);

    // Otherwise, allow if either key is present (runtime will choose).
    return Boolean(openai || anthropic);
  });
}

async function main(): Promise<void> {
  const repoRoot = await getRepoRoot(process.cwd());
  const worktree = await createDetachedWorktree(repoRoot);
  const cwdResult = await setCwd(worktree);
  if (!cwdResult.success) {
    await removeWorktree(repoRoot, worktree);
    throw new Error(`Failed to set CWD: ${cwdResult.error ?? cwdResult.path}`);
  }
  process.chdir(cwdResult.path);

  const runtime = await initializeAgent();
  try {
    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
    if (!service) {
      throw new Error("CodeTaskService not available");
    }

    const runnable = getRunnableTypes();
    if (runnable.length === 0) {
      throw new Error(
        "No runnable sub-agents (set OPENAI_API_KEY and/or ANTHROPIC_API_KEY).",
      );
    }

    logLine(
      `[${nowIso()}] running e2e sub-agent checks: ${runnable.join(", ")}`,
    );

    const before = await gitStatusPorcelain(worktree);
    if (before.length > 0) {
      logLine(
        `[${nowIso()}] warning: worktree is not clean before run:\n${before}`,
      );
    }

    const results: RunResult[] = [];
    for (const type of runnable) {
      results.push(await runOne(service, type));
    }

    const after = await gitStatusPorcelain(worktree);
    const repoDirtyAfter = after.length > 0 ? after : null;

    logLine("");
    logLine("=== Results ===");
    for (const r of results) {
      logLine(`- ${r.type}: ${r.status} (${r.taskId}) — ${r.summary}`);
    }
    if (repoDirtyAfter) {
      logLine("");
      logLine("=== Worktree status (dirty) ===");
      logLine(repoDirtyAfter);
    }

    const failed = results.filter((r) => r.status !== "completed");
    if (failed.length > 0 || repoDirtyAfter) {
      process.exitCode = 1;
      logLine("");
      const parts: string[] = [];
      if (failed.length > 0)
        parts.push(`${failed.length} sub-agent(s) did not complete`);
      if (repoDirtyAfter) parts.push("repository changed during run");
      logLine(`FAILED: ${parts.join("; ")}`);
    } else {
      logLine("");
      logLine("OK: all sub-agents completed");
    }
  } finally {
    await shutdownAgent(runtime);
    await removeWorktree(repoRoot, worktree);
  }
}

await main();
