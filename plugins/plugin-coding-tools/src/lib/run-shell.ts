/**
 * Plugin-local shell-execution chokepoint.
 *
 * Mirrors the contract of `runShell` in `@elizaos/agent` but is owned by this
 * plugin so the plugin → agent dependency direction stays clean. Whoever holds
 * an `IAgentRuntime` calls this from the SHELL action handler; the body
 * dispatches against the runtime mode.
 */

import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  rmSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import * as importPath from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import {
  CapabilityError,
  getCapabilityRouter,
  type IAgentRuntime,
} from "@elizaos/core";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";
import {
  detectTerminalSupport,
  missingToolForCommand,
  missingToolMessage,
  resolveHostShell,
} from "./terminal-capabilities.js";

export type ShellSandboxBackend =
  | "host"
  | "capability-router"
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

export interface BackgroundShellStartResult {
  process: HostShellProcess;
  pid: number | undefined;
  sandbox: ShellSandboxBackend;
  startedAt: number;
}

export interface HostShellProcess {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  stdin: HostShellWritable | null;
  kill(signal?: NodeJS.Signals): void;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface HostShellWritable {
  write(chunk: string): unknown;
  end(): unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
  on?(event: "error", listener: (error: Error) => void): unknown;
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
    runtime as {
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

function shellArgsForCommand(shell: {
  command: string;
  args: string[];
}): string[] {
  const basename = importPath.basename(shell.command).toLowerCase();
  if (basename === "bash") {
    const commandFlagIndex = shell.args.lastIndexOf("-c");
    const startupFlags = ["--noprofile", "--norc", "-o", "pipefail"];
    if (commandFlagIndex >= 0) {
      return [
        ...startupFlags,
        ...shell.args.slice(0, commandFlagIndex),
        ...shell.args.slice(commandFlagIndex),
      ];
    }
    return [...startupFlags, ...shell.args];
  }
  if (basename === "zsh") {
    const commandFlagIndex = shell.args.lastIndexOf("-c");
    const startupFlags = ["-f", "-o", "pipefail"];
    if (commandFlagIndex >= 0) {
      return [
        ...startupFlags,
        ...shell.args.slice(0, commandFlagIndex),
        ...shell.args.slice(commandFlagIndex),
      ];
    }
    return [...startupFlags, ...shell.args];
  }
  return shell.args;
}

function killHostProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
  proc: HostShellProcess,
): void {
  try {
    if (pid && useProcessGroup) {
      process.kill(-pid, signal);
      return;
    }
    proc.kill(signal);
  } catch {
    // error-policy:J6 best-effort teardown; the process may have exited between
    // the timeout firing and kill delivery, so a failed signal is a no-op.
  }
}

interface BunHostSubprocess {
  pid: number;
  stdout: unknown;
  stderr: unknown;
  stdin?: {
    write(chunk: string): unknown;
    end(): unknown;
  };
  exited: Promise<number>;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
}

interface BunHostRuntime {
  spawn(options: {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: "ignore" | "pipe";
    stdout: "pipe";
    stderr: "pipe";
    detached: boolean;
    onExit: (
      proc: BunHostSubprocess,
      code: number,
      signal: NodeJS.Signals | null,
      error?: Error,
    ) => void;
  }): BunHostSubprocess;
}

function getBunRuntime(): BunHostRuntime | null {
  return (globalThis as { Bun?: BunHostRuntime }).Bun ?? null;
}

function isBunRuntime(): boolean {
  return typeof getBunRuntime()?.spawn === "function";
}

function startHostProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  detached: boolean;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) => void;
}): HostShellProcess {
  if (isBunRuntime()) {
    return startBunHostProcess(opts);
  }
  return spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin, "pipe", "pipe"],
    detached: opts.detached,
  }) as HostShellProcess;
}

function startBunHostProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  detached: boolean;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) => void;
}): HostShellProcess {
  const events = new EventEmitter();
  const stdinFifo =
    opts.stdin === "pipe" && process.platform !== "win32"
      ? createStdinFifo()
      : null;
  const commandArgs = stdinFifo
    ? withShellStdinRedirect(opts.args, stdinFifo.path)
    : opts.args;
  const bun = getBunRuntime();
  if (!bun) {
    throw new Error("Bun runtime is unavailable");
  }
  const proc = bun.spawn({
    cmd: [opts.command, ...commandArgs],
    cwd: opts.cwd,
    env: opts.env as Record<string, string | undefined>,
    stdin: opts.stdin,
    stdout: "pipe",
    stderr: "pipe",
    detached: opts.detached,
    onExit: (_proc, code, signal, error) => {
      opts.onExit?.(code, signal as NodeJS.Signals | null, error);
    },
  });
  const stdout = Readable.fromWeb(proc.stdout as never);
  const stderr = Readable.fromWeb(proc.stderr as never);
  const stdin = stdinFifo?.open(events) ?? null;
  const bunStdin = proc.stdin;
  const stdoutEnded = streamEnded(stdout);
  const stderrEnded = streamEnded(stderr);
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let exitError: Error | undefined;

  proc.exited
    .then((code) => {
      exitCode = code;
      signalCode = proc.signalCode;
    })
    .catch((error: unknown) => {
      exitCode = -1;
      exitError = error instanceof Error ? error : new Error(String(error));
      events.emit("error", exitError);
    })
    .finally(() => {
      Promise.allSettled([stdoutEnded, stderrEnded]).then(() => {
        stdinFifo?.cleanup();
        events.emit("close", exitCode, signalCode);
      });
    });

  return {
    pid: proc.pid,
    stdout,
    stderr,
    stdin:
      stdin ??
      (opts.stdin === "pipe" && bunStdin
        ? {
            write(chunk: string) {
              return bunStdin.write(chunk);
            },
            end() {
              return bunStdin.end();
            },
          }
        : null),
    kill(signal?: NodeJS.Signals) {
      proc.kill(signal);
    },
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
  };
}

function streamEnded(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded) {
      resolve();
      return;
    }
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
}

function createStdinFifo(): {
  path: string;
  open(events: EventEmitter): HostShellWritable;
  cleanup(): void;
} {
  const dir = mkdtempSync(importPath.join(tmpdir(), "eliza-bg-stdin-"));
  const fifoPath = importPath.join(dir, "stdin");
  execFileSync("mkfifo", [fifoPath]);
  let stream: WriteStream | null = null;
  return {
    path: fifoPath,
    open(events: EventEmitter) {
      stream = createWriteStream(fifoPath, { encoding: "utf8" });
      stream.on("error", (error) => events.emit("error", error));
      return {
        write(chunk: string) {
          return stream?.write(chunk);
        },
        end() {
          return stream?.end();
        },
      };
    },
    cleanup() {
      stream?.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withShellStdinRedirect(args: string[], fifoPath: string): string[] {
  const commandFlagIndex = args.lastIndexOf("-c");
  if (commandFlagIndex < 0 || commandFlagIndex + 1 >= args.length) {
    return args;
  }
  const redirected = `exec < ${quoteShellArg(fifoPath)}; ${
    args[commandFlagIndex + 1]
  }`;
  return [
    ...args.slice(0, commandFlagIndex + 1),
    redirected,
    ...args.slice(commandFlagIndex + 2),
  ];
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function runOnHost(opts: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<ShellResult> {
  return runOnHostWithShell(opts, resolveHostShell()).then(async (result) => {
    const shell = resolveHostShell();
    const basename = importPath.basename(shell.command).toLowerCase();
    if (
      basename === "zsh" &&
      result.exitCode !== 0 &&
      result.stdout.length === 0 &&
      result.stderr.length === 0
    ) {
      const bash = resolveExecutableForHost("bash", "/bin/bash");
      if (bash && bash !== shell.command) {
        return runOnHostWithShell(opts, {
          command: bash,
          args: ["-c"],
          available: true,
          source: "candidate",
        });
      }
    }
    return result;
  });
}

function assertHostBackgroundSupported(
  runtime: IAgentRuntime,
  command: string,
  cwd: string,
): void {
  if (getCapabilityRouter(runtime)) {
    throw new Error(
      "Background shell sessions are not supported by the capability-router backend.",
    );
  }

  const mode = resolveRuntimeExecutionMode(runtime);
  if (mode === "cloud") {
    throw new Error("Background shell sessions are disabled in cloud mode.");
  }
  if (mode === "local-safe") {
    throw new Error(
      "Background shell sessions require a managed sandbox backend with session support; this runtime only exposes one-shot sandbox exec.",
    );
  }

  const support = detectTerminalSupport();
  if (!support.supported) {
    throw new Error(
      support.message ?? "Local terminal execution is unavailable.",
    );
  }

  const missingTool = missingToolForCommand(command);
  if (missingTool) {
    throw new Error(missingToolMessage(missingTool));
  }

  const resolvedCwd = importPath.resolve(cwd);
  if (!existsSync(resolvedCwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
}

export function startBackgroundShellOnHost(
  runtime: IAgentRuntime,
  opts: {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): BackgroundShellStartResult {
  assertHostBackgroundSupported(runtime, opts.command, opts.cwd);
  const shell = resolveHostShell();
  if (!shell.available) {
    throw new Error(shell.warning ?? "No executable shell was detected.");
  }
  const useProcessGroup = process.platform !== "win32";
  const proc = startHostProcess({
    command: shell.command,
    args: [...shellArgsForCommand(shell), opts.command],
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdin: "pipe",
    detached: useProcessGroup,
  });
  return {
    process: proc,
    pid: proc.pid,
    sandbox: "host",
    startedAt: Date.now(),
  };
}

export function signalHostProcessGroup(
  proc: HostShellProcess,
  signal: NodeJS.Signals,
): void {
  killHostProcess(proc.pid, signal, process.platform !== "win32", proc);
}

function resolveExecutableForHost(
  name: string,
  fallback: string,
): string | undefined {
  const pathEntries = (process.env.PATH ?? "")
    .split(importPath.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = importPath.join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(fallback)) return fallback;
  return undefined;
}

function runOnHostWithShell(
  opts: {
    command: string;
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  },
  shell: ReturnType<typeof resolveHostShell>,
): Promise<ShellResult> {
  const start = Date.now();
  return new Promise<ShellResult>((resolve) => {
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
    const useProcessGroup = process.platform !== "win32";
    const proc = startHostProcess({
      command: shell.command,
      args: [...shellArgsForCommand(shell), opts.command],
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      detached: useProcessGroup,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < STREAM_CAP_CHARS * 2) {
        stdout += chunk.toString("utf8");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STREAM_CAP_CHARS * 2) {
        stderr += chunk.toString("utf8");
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killHostProcess(proc.pid, "SIGTERM", useProcessGroup, proc);
      setTimeout(() => {
        killHostProcess(proc.pid, "SIGKILL", useProcessGroup, proc);
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

async function runThroughCapabilityRouter(
  runtime: IAgentRuntime,
  opts: RunShellOptions,
): Promise<ShellResult | null> {
  const router = getCapabilityRouter(runtime);
  if (!router) return null;
  const start = Date.now();
  try {
    const result = await router.pty.runCommand({
      command: opts.command,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    return {
      exitCode: result.exitCode ?? -1,
      signal: null,
      stdout: result.output,
      stderr: "",
      durationMs: Date.now() - start,
      timedOut: result.timedOut,
      sandbox: "capability-router",
    };
  } catch (error) {
    // error-policy:J4 only the expected "no PTY capability" shape
    // (CAPABILITY_UNAVAILABLE) degrades to null below (advancing to the
    // host-shell fallback); any other router error rethrows so a genuine
    // execution failure reaches the SHELL action.
    if (
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE"
    ) {
      return null;
    }
    throw error;
  }
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

  const routed = await runThroughCapabilityRouter(runtime, opts);
  if (routed) return routed;

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
