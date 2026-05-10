/**
 * Process execution utilities with command queuing.
 *
 * Provides cross-platform child process execution with:
 * - Windows command resolution (.cmd extension handling)
 * - Timeout support
 * - Lane-based command queuing for serialization
 * - Signal forwarding between parent and child processes
 *
 * @module utils/processQueue
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";

// ============================================================================
// Command Lanes
// ============================================================================

/**
 * Command execution lanes for organizing concurrent command execution.
 * Lanes allow serialization within a lane while permitting parallelism across lanes.
 */
export const CommandLane = {
  Main: "main",
  Cron: "cron",
  Subagent: "subagent",
  Nested: "nested",
} as const;

export type CommandLane = (typeof CommandLane)[keyof typeof CommandLane];

// ============================================================================
// Process Execution
// ============================================================================

const execFileAsync = promisify(execFile);

/**
 * Resolves a command for Windows compatibility.
 * On Windows, non-.exe commands (like npm) require their .cmd extension.
 */
function resolveCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const basename = path.basename(command).toLowerCase();
  const ext = path.extname(basename);
  if (ext) {
    return command;
  }
  const cmdCommands = ["npm", "yarn", "npx"];
  if (cmdCommands.includes(basename)) {
    return `${command}.cmd`;
  }
  return command;
}

function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"] {
  const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
  return [stdin, "pipe", "pipe"];
}

/**
 * Simple promise-wrapped execFile with timeout support.
 *
 * @param command - The command to execute
 * @param args - Command arguments
 * @param opts - Timeout in ms or options object
 * @returns Promise resolving to stdout and stderr
 */
export async function runExec(
  command: string,
  args: string[],
  opts: number | { timeoutMs?: number; maxBuffer?: number } = 10_000
): Promise<{ stdout: string; stderr: string }> {
  const options =
    typeof opts === "number"
      ? { timeout: opts, encoding: "utf8" as const }
      : {
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          encoding: "utf8" as const,
        };
  const { stdout, stderr } = await execFileAsync(resolveCommand(command), args, options);
  return { stdout, stderr };
}

/**
 * Result from a spawned command execution.
 */
export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
};

/**
 * Options for running a command with timeout.
 */
export type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
};

/**
 * Run a command with timeout, input, and environment control.
 *
 * @param argv - Command and arguments as array
 * @param optionsOrTimeout - Options object or timeout in ms
 * @returns Promise resolving to spawn result
 */
export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions
): Promise<SpawnResult> {
  const mode = resolveRuntimeExecutionMode();
  if (mode === "cloud") {
    throw new Error("Local shell execution disabled in cloud mode.");
  }
  if (mode === "local-safe") {
    throw new Error(
      "[shell] runCommandWithTimeout cannot route through SandboxManager from this code path; use the runtime-aware shell action.",
    );
  }

  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const { timeoutMs, cwd, input, env } = options;
  const { windowsVerbatimArguments } = options;
  const hasInput = input !== undefined;

  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const resolvedEnv = env ? { ...process.env, ...env } : { ...process.env };
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }

  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });
  const child = spawn(resolveCommand(argv[0]), argv.slice(1), {
    stdio,
    cwd,
    env: resolvedEnv,
    windowsVerbatimArguments,
  });

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (typeof child.kill === "function") {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    if (hasInput && child.stdin) {
      child.stdin.write(input ?? "");
      child.stdin.end();
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, killed: child.killed });
    });
  });
}

// ============================================================================
// Command Queue
// ============================================================================

type QueueEntry = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  active: number;
  maxConcurrent: number;
  draining: boolean;
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    active: 0,
    maxConcurrent: 1,
    draining: false,
  };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    return;
  }
  state.draining = true;

  const pump = () => {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry;
      const waitedMs = Date.now() - entry.enqueuedAt;
      if (waitedMs >= entry.warnAfterMs) {
        entry.onWait?.(waitedMs, state.queue.length);
      }
      state.active += 1;
      void (async () => {
        try {
          const result = await entry.task();
          state.active -= 1;
          pump();
          entry.resolve(result);
        } catch (err) {
          state.active -= 1;
          pump();
          entry.reject(err);
        }
      })();
    }
    state.draining = false;
  };

  pump();
}

/**
 * Set the maximum concurrency for a command lane.
 *
 * @param lane - The lane name
 * @param maxConcurrent - Maximum concurrent tasks
 */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

/**
 * Enqueue a task to execute in a specific lane.
 *
 * @param lane - The lane name
 * @param task - Async task function
 * @param opts - Options including warning threshold and callbacks
 * @returns Promise resolving when task completes
 */
export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  }
): Promise<T> {
  const cleaned = lane.trim() || CommandLane.Main;
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    drainLane(cleaned);
  });
}

/**
 * Enqueue a task to execute in the main lane.
 *
 * @param task - Async task function
 * @param opts - Options including warning threshold and callbacks
 * @returns Promise resolving when task completes
 */
export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  }
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

/**
 * Get the current queue size for a lane (queued + active).
 *
 * @param lane - The lane name (defaults to main)
 * @returns Queue size
 */
export function getQueueSize(lane: string = CommandLane.Main): number {
  const resolved = lane.trim() || CommandLane.Main;
  const state = lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return state.queue.length + state.active;
}

/**
 * Get total queue size across all lanes.
 *
 * @returns Total queue size
 */
export function getTotalQueueSize(): number {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.queue.length + s.active;
  }
  return total;
}

/**
 * Clear all pending tasks in a lane.
 *
 * @param lane - The lane name (defaults to main)
 * @returns Number of tasks cleared
 */
export function clearCommandLane(lane: string = CommandLane.Main): number {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  state.queue.length = 0;
  return removed;
}

// ============================================================================
// Child Process Bridge
// ============================================================================

/**
 * Options for attaching a child process signal bridge.
 */
export type ChildProcessBridgeOptions = {
  signals?: NodeJS.Signals[];
  onSignal?: (signal: NodeJS.Signals) => void;
};

const defaultSignals: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/**
 * Attach signal forwarding from parent to child process.
 * Signals sent to the parent will be forwarded to the child.
 * Automatically detaches when child exits.
 *
 * @param child - The child process
 * @param options - Bridge options
 * @returns Object with detach function
 */
export function attachChildProcessBridge(
  child: ChildProcess,
  { signals = defaultSignals, onSignal }: ChildProcessBridgeOptions = {}
): { detach: () => void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = (): void => {
      onSignal?.(signal);
      try {
        child.kill(signal);
      } catch {
        // ignore - child may have already exited
      }
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform
    }
  }

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };

  child.once("exit", detach);
  child.once("error", detach);

  return { detach };
}
