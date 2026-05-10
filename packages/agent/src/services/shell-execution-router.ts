/**
 * Single chokepoint for shell execution.
 *
 * The runtime has a 3-mode switch via `ELIZA_RUNTIME_MODE`:
 *  - `cloud`        — agent code runs in the hosted backend; local exec is
 *                     refused with a clear error.
 *  - `local-safe`   — every shell exec is routed through `SandboxManager`
 *                     (Docker / Apple Container) so the host filesystem is
 *                     not directly touched.
 *  - `local-yolo`   — direct host exec (the historical default).
 *
 * Plugins, services, and CLI helpers that previously called `child_process.spawn`
 * for one-shot command execution should call `runShell()` instead. This keeps
 * the mode dispatch in one place and lets the privacy/sandbox guarantees of
 * `local-safe` actually hold.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import type { SandboxManager } from "./sandbox-manager.ts";

export type ShellExecutionMode = "cloud" | "local-safe" | "local-yolo";

export type ShellSandboxBackend =
  | "host"
  | "docker"
  | "apple-container"
  | "wsl2"
  | "appcontainer"
  | "none";

export interface ShellRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Caller identity for audit trails. Required so logs are traceable. */
  toolName: string;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sandbox: ShellSandboxBackend;
}

export interface ShellRouterContext {
  /** Explicit override for the active mode. When unset, env vars are read. */
  mode?: ShellExecutionMode;
  /** Runtime-style settings source consulted before falling back to env. */
  runtime?: { getSetting?: (key: string) => unknown } | null;
  /** Optional pre-resolved sandbox manager (used by tests + agent code paths). */
  sandboxManager?: SandboxManager | null;
  /**
   * Lazy provider for SandboxManager. Awaited only when local-safe is active,
   * so callers in local-yolo mode never pay for sandbox-engine imports.
   */
  resolveSandboxManager?: () => Promise<SandboxManager | null>;
}

const KNOWN_MODES: ReadonlySet<ShellExecutionMode> = new Set([
  "cloud",
  "local-safe",
  "local-yolo",
]);

function normalizeMode(value: unknown): ShellExecutionMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return KNOWN_MODES.has(trimmed as ShellExecutionMode)
    ? (trimmed as ShellExecutionMode)
    : null;
}

export function resolveShellExecutionMode(
  ctx?: Pick<ShellRouterContext, "mode" | "runtime"> | null,
): ShellExecutionMode {
  if (ctx?.mode) return ctx.mode;
  const runtime = ctx?.runtime ?? null;
  const candidates: unknown[] = [
    runtime?.getSetting?.("ELIZA_RUNTIME_MODE"),
    runtime?.getSetting?.("RUNTIME_MODE"),
    runtime?.getSetting?.("LOCAL_RUNTIME_MODE"),
    process.env.ELIZA_RUNTIME_MODE,
    process.env.RUNTIME_MODE,
    process.env.LOCAL_RUNTIME_MODE,
  ];
  for (const candidate of candidates) {
    const resolved = normalizeMode(candidate);
    if (resolved) return resolved;
  }
  return "local-yolo";
}

function backendForSandboxManager(manager: SandboxManager): ShellSandboxBackend {
  // SandboxManager keeps its engine private; reach in only to label the
  // backend in ShellResult. If the shape ever changes, the fallback is the
  // safe "none" value and callers still see a well-formed result.
  const engine = (manager as unknown as { engine?: { engineType?: string } })
    .engine;
  const engineType = engine?.engineType;
  if (engineType === "docker") return "docker";
  if (engineType === "apple-container") return "apple-container";
  return "none";
}

async function resolveSandboxManager(
  ctx: ShellRouterContext | null | undefined,
): Promise<SandboxManager | null> {
  if (ctx?.sandboxManager !== undefined) return ctx.sandboxManager;
  if (ctx?.resolveSandboxManager) return await ctx.resolveSandboxManager();
  return null;
}

async function runOnHost(req: ShellRequest): Promise<ShellResult> {
  const start = Date.now();
  return await new Promise<ShellResult>((resolve) => {
    const timeoutMs = req.timeoutMs ?? 30_000;
    const child = spawn(req.command, req.args.slice(), {
      cwd: req.cwd,
      env: req.env ? { ...process.env, ...req.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // child may already have exited
      }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr.length > 0 ? `${stderr}\n${err.message}` : err.message,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (code ?? -1);
      resolve({
        exitCode,
        stdout,
        stderr: timedOut
          ? `${stderr}${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}[shell-router] command timed out after ${timeoutMs}ms`
          : stderr,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
    });
  });
}

async function runInSandbox(
  req: ShellRequest,
  manager: SandboxManager,
): Promise<ShellResult> {
  const result = await manager.run({
    cmd: req.command,
    args: req.args,
    workdir: req.cwd,
    env: req.env,
    timeoutMs: req.timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    sandbox: backendForSandboxManager(manager),
  };
}

/**
 * Single entry point for one-shot shell execution. Mode dispatch:
 *   - `cloud`      → throws.
 *   - `local-safe` → routed through SandboxManager.run; if no manager is
 *                    available the call throws so callers cannot silently
 *                    fall back to the host.
 *   - `local-yolo` → direct host exec via child_process.spawn.
 *
 * On Windows, `local-safe` currently throws because no Windows sandbox
 * backend is wired up yet; callers must opt in to `local-yolo` explicitly.
 */
export async function runShell(
  req: ShellRequest,
  ctx?: ShellRouterContext | null,
): Promise<ShellResult> {
  if (!req.command || req.command.length === 0) {
    throw new Error("[shell-router] runShell requires a non-empty command");
  }
  if (!req.toolName || req.toolName.length === 0) {
    throw new Error("[shell-router] runShell requires toolName for audit");
  }

  const mode = resolveShellExecutionMode(ctx);

  if (mode === "cloud") {
    throw new Error("Local shell execution disabled in cloud mode.");
  }

  if (mode === "local-safe") {
    if (process.platform === "win32") {
      throw new Error(
        "[shell-router] Windows local-safe sandbox not yet implemented",
      );
    }
    const manager = await resolveSandboxManager(ctx);
    if (!manager) {
      throw new Error(
        "[shell-router] local-safe mode requires SandboxManager but none is available",
      );
    }
    return await runInSandbox(req, manager);
  }

  return await runOnHost(req);
}
