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
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  type RuntimeExecutionMode,
  resolveRuntimeExecutionMode,
} from "@elizaos/shared";
import { CapabilityBroker } from "./capability-broker.ts";
import type { SandboxManager } from "./sandbox-manager.ts";
import { isVfsUri, runVfsBuiltinShell } from "./vfs-builtin-shell.ts";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

export type ShellExecutionMode = RuntimeExecutionMode;

export type ShellSandboxBackend =
  | "host"
  | "docker"
  | "apple-container"
  | "wsl2"
  | "appcontainer"
  | "vfs"
  | "none";

export interface ShellRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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

interface ParsedVfsShellCwd {
  projectId: string;
  virtualPath: string;
}

export function resolveShellExecutionMode(
  ctx?: Pick<ShellRouterContext, "mode" | "runtime"> | null,
): ShellExecutionMode {
  if (ctx?.mode) return ctx.mode;
  return resolveRuntimeExecutionMode(ctx?.runtime ?? null);
}

function backendForSandboxManager(
  manager: SandboxManager,
): ShellSandboxBackend {
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

// Router-scoped broker so the shell.exec policy is driven by the same mode
// resolver runShell uses for dispatch. The broker singleton in
// capability-broker.ts hardcodes `local-safe` as its default mode, which is
// correct for cloud-side callers but wrong for host-side runShell — those
// must follow ELIZA_RUNTIME_MODE/RUNTIME_MODE/LOCAL_RUNTIME_MODE. The
// internal mutable holder lets the broker re-read mode on every call without
// constructing a new CapabilityBroker per runShell invocation.
const routerModeHolder: { current: ShellExecutionMode } = {
  current: "local-yolo",
};
let cachedRouterBroker: CapabilityBroker | null = null;
function getRouterBroker(
  modeSource: () => ShellExecutionMode,
): CapabilityBroker {
  routerModeHolder.current = modeSource();
  if (cachedRouterBroker) return cachedRouterBroker;
  cachedRouterBroker = new CapabilityBroker({
    mode: () => routerModeHolder.current,
  });
  return cachedRouterBroker;
}

/** Test-only escape hatch — drops the cached router broker. */
export function __resetShellRouterBrokerForTests(): void {
  cachedRouterBroker = null;
  routerModeHolder.current = "local-yolo";
}

async function runOnHost(req: ShellRequest): Promise<ShellResult> {
  const start = Date.now();
  return await new Promise<ShellResult>((resolve) => {
    const timeoutMs = req.timeoutMs ?? 30_000;
    const useDetachedProcessGroup = process.platform !== "win32";
    const child = spawn(req.command, req.args.slice(), {
      cwd: req.cwd,
      env: req.env ? { ...process.env, ...req.env } : process.env,
      detached: useDetachedProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const killChildTree = () => {
      try {
        if (useDetachedProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
          return;
        }
      } catch {
        // Fall back to killing the direct child below.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // child may already have exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      req.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      req.onStderr?.(text);
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
  if (result.stdout) req.onStdout?.(result.stdout);
  if (result.stderr) req.onStderr?.(result.stderr);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    sandbox: backendForSandboxManager(manager),
  };
}

async function runVfsInSandbox(
  req: ShellRequest,
  cwd: ParsedVfsShellCwd,
  manager: SandboxManager,
): Promise<ShellResult> {
  const workspaceRoot = manager.getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error(
      "[shell-router] VFS sandbox execution requires SandboxManager.getWorkspaceRoot()",
    );
  }

  const vfs = createVirtualFilesystemService({ projectId: cwd.projectId });
  await vfs.initialize();
  const normalizedCwd = vfs.resolveVirtualPath(cwd.virtualPath);
  const materializedRoot = path.join(
    workspaceRoot,
    "vfs-projects",
    vfs.projectId,
    "files",
  );
  await fsp.rm(materializedRoot, { recursive: true, force: true });
  await fsp.mkdir(materializedRoot, { recursive: true, mode: 0o700 });
  await materializeVfsTree(vfs, materializedRoot);

  const hostCwd = path.resolve(
    materializedRoot,
    normalizedCwd.replace(/^\/+/, ""),
  );
  if (!isInsideOrEqual(materializedRoot, hostCwd)) {
    throw new Error("[shell-router] vfs:// cwd escapes materialized root");
  }
  await fsp.mkdir(hostCwd, { recursive: true, mode: 0o700 });
  const sandboxCwd =
    manager.getContainerWorkspacePath(hostCwd) ??
    `/workspace/${path
      .relative(workspaceRoot, hostCwd)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")}`;

  try {
    return await runInSandbox(
      {
        ...req,
        cwd: sandboxCwd,
      },
      manager,
    );
  } finally {
    await importMaterializedTree(vfs, materializedRoot);
  }
}

async function materializeVfsTree(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  root: string,
): Promise<void> {
  for (const file of await vfs.exportFiles()) {
    const target = path.resolve(root, file.path.replace(/^\/+/, ""));
    if (!isInsideOrEqual(root, target)) {
      throw new Error(
        `[shell-router] VFS export path escapes materialized root: ${file.path}`,
      );
    }
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.writeFile(target, file.bytes, { mode: 0o600 });
  }
}

async function importMaterializedTree(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  root: string,
): Promise<void> {
  const nextFiles = new Map<string, Buffer>();
  await walkMaterialized(root, root, nextFiles);

  const currentFiles = await vfs.exportFiles();
  for (const file of currentFiles) {
    const normalized = file.path.replace(/^\/+/, "");
    if (!nextFiles.has(normalized)) {
      await vfs.delete(normalized);
    }
  }
  for (const [virtualPath, bytes] of nextFiles) {
    await vfs.writeFile(virtualPath, bytes);
  }
}

async function walkMaterialized(
  root: string,
  dir: string,
  files: Map<string, Buffer>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`VFS sandbox import rejects symlink: ${absolute}`);
    }
    if (entry.isDirectory()) {
      await walkMaterialized(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const virtualPath = path.relative(root, absolute).replace(/\\/g, "/");
    files.set(virtualPath, await fsp.readFile(absolute));
  }
}

function parseVfsShellCwd(value: string): ParsedVfsShellCwd {
  const parsed = new URL(value);
  if (parsed.protocol !== "vfs:" || !parsed.hostname) {
    throw new Error(`Invalid VFS uri: ${value}`);
  }
  return {
    projectId: parsed.hostname,
    virtualPath: decodeURIComponent(parsed.pathname || "/"),
  };
}

function assertShellCapability(
  req: ShellRequest,
  mode: ShellExecutionMode,
  toolName: string,
): void {
  const decision = getRouterBroker(() => mode).check({
    kind: "shell",
    op: "exec",
    target: req.command,
    toolName,
  });
  if (decision.allowed !== true) {
    throw new Error(`[shell] capability denied: ${decision.reason}`);
  }
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

  if (isVfsUri(req.cwd)) {
    const vfsCwd = parseVfsShellCwd(req.cwd);
    if (mode === "local-yolo") {
      throw new Error(
        "[shell-router] local-yolo uses the normal host filesystem; pass a real cwd path instead of vfs://",
      );
    }
    const manager = await resolveSandboxManager(ctx);
    if (manager) {
      assertShellCapability(req, mode, `sandbox.${req.toolName}`);
      return await runVfsInSandbox(req, vfsCwd, manager);
    }
    if (mode === "local-safe" && !isIosPlatform()) {
      throw new Error(
        "[shell-router] local-safe mode requires SandboxManager but none is available",
      );
    }
    const result = await runVfsBuiltinShell({
      cwdUri: req.cwd,
      command: req.command,
      args: req.args,
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    });
    if (result.stdout) req.onStdout?.(result.stdout);
    if (result.stderr) req.onStderr?.(result.stderr);
    return result;
  }

  if (mode === "local-safe") {
    assertShellCapability(req, mode, `sandbox.${req.toolName}`);
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

  assertShellCapability(req, mode, req.toolName);
  return await runOnHost(req);
}

function isInsideOrEqual(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isIosPlatform(): boolean {
  return process.env.ELIZA_PLATFORM?.trim().toLowerCase() === "ios";
}
