/**
 * Plugin-local shell-execution chokepoint.
 *
 * Mirrors the contract of `runShell` in `@elizaos/agent` but is owned by this
 * plugin so the plugin → agent dependency direction stays clean. Whoever holds
 * an `IAgentRuntime` calls this from the SHELL action handler; the body
 * dispatches against the runtime mode.
 */

import { spawn } from "node:child_process";
import * as importPath from "node:path";
import process from "node:process";
import type { IAgentRuntime } from "@elizaos/core";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";
import {
  detectTerminalSupport,
  missingToolForCommand,
  missingToolMessage,
  resolveHostShell,
} from "./terminal-capabilities.js";

export type ShellSandboxBackend =
  | "host"
  | "docker"
  | "apple-container"
  | "wsl2"
  | "appcontainer"
  | "none";

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sandbox: ShellSandboxBackend;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

interface RuntimeSandboxManager {
  exec: (options: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
  }) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    executedInSandbox: boolean;
  }>;
}

function getRuntimeSandboxManager(
  runtime: IAgentRuntime,
): RuntimeSandboxManager | null {
  const candidate = (
    runtime as unknown as {
      getSandboxManager?: () => RuntimeSandboxManager | null;
    }
  ).getSandboxManager?.();
  return candidate ?? null;
}

function backendForManager(
  manager: RuntimeSandboxManager,
): ShellSandboxBackend {
  const internal = manager as RuntimeSandboxManager & {
    engine?: { engineType?: string };
  };
  const engineType = internal.engine?.engineType;
  if (engineType === "docker") return "docker";
  if (engineType === "apple-container") return "apple-container";
  return "none";
}

function toSandboxWorkdir(cwd: string): string | undefined {
  const root = process.cwd();
  const relative = importPath.relative(
    importPath.resolve(root),
    importPath.resolve(cwd),
  );
  if (relative === "") return "/workspace";
  if (!relative.startsWith("..") && !importPath.isAbsolute(relative)) {
    return `/workspace/${relative}`;
  }
  return undefined;
}

const STREAM_CAP_CHARS = 30_000;

function runOnHost(opts: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<ShellResult> {
  const start = Date.now();
  return new Promise<ShellResult>((resolve) => {
    const shell = resolveHostShell();
    if (!shell.available) {
      resolve({
        exitCode: -1,
        signal: null,
        stdout: "",
        stderr: shell.warning ?? "No executable shell was detected.",
        timedOut: false,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
      return;
    }
    const proc = spawn(shell.command, [...shell.args, opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STREAM_CAP_CHARS * 2) {
        stdout += chunk.toString("utf8");
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STREAM_CAP_CHARS * 2) {
        stderr += chunk.toString("utf8");
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 1500);
    }, opts.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        signal: null,
        stdout,
        stderr: stderr.length > 0 ? `${stderr}\n${err.message}` : err.message,
        timedOut,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
    });
  });
}

export interface RunShellOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
}

/**
 * Run a shell command, dispatching against the active runtime mode:
 *  - `cloud`      → throws ("Local shell execution disabled in cloud mode.").
 *  - `local-safe` → SandboxManager.exec; refuses if the sandbox is unavailable
 *                   or the cwd is outside the workspace.
 *  - `local-yolo` → /bin/bash -c host exec.
 */
export async function runShell(
  runtime: IAgentRuntime,
  opts: RunShellOptions,
): Promise<ShellResult> {
  const mode = resolveRuntimeExecutionMode(runtime);

  if (mode === "cloud") {
    throw new Error("Local shell execution disabled in cloud mode.");
  }

  const support = detectTerminalSupport();
  if (!support.supported) {
    throw new Error(
      support.message ?? "Local terminal execution is unavailable.",
    );
  }

  const missingTool = missingToolForCommand(opts.command);
  if (missingTool) {
    throw new Error(missingToolMessage(missingTool));
  }

  if (mode === "local-safe") {
    if (process.platform === "win32") {
      throw new Error(
        "[coding-tools] Windows local-safe sandbox not yet implemented",
      );
    }
    const manager = getRuntimeSandboxManager(runtime);
    if (!manager) {
      throw new Error(
        "local-safe mode requires SandboxManager, but no sandbox manager is available for command execution.",
      );
    }
    const sandboxWorkdir = toSandboxWorkdir(opts.cwd);
    if (!sandboxWorkdir) {
      throw new Error(
        `local-safe mode can only execute inside the sandbox workspace; cwd is outside process workspace: ${opts.cwd}`,
      );
    }
    const result = await manager.exec({
      command: opts.command,
      workdir: sandboxWorkdir,
      timeoutMs: opts.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: false,
      sandbox: backendForManager(manager),
    };
  }

  return runOnHost({
    command: opts.command,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: process.env,
  });
}
