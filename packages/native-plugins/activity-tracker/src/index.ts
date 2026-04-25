/**
 * Native activity-tracker driver.
 *
 * Spawns the compiled macOS `activity-collector` helper and exposes a typed
 * event stream of window/app focus transitions. Non-Darwin platforms are
 * unsupported — callers must check {@link isSupportedPlatform} and degrade.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

export type ActivityEventKind = "activate" | "deactivate";

export interface ActivityCollectorEvent {
  ts: number;
  event: ActivityEventKind;
  bundleId: string;
  appName: string;
  windowTitle?: string;
}

/**
 * Periodic HID idle sample emitted by the Swift collector at a fixed cadence
 * (default 30s). Backed by `CGEventSourceSecondsSinceLastEventType` against
 * the combined session state, so it reports the signed-in owner's idle time
 * for the active console session.
 */
export interface ActivityCollectorIdleSample {
  ts: number;
  event: "hid_idle";
  idleSeconds: number;
}

export interface ActivityCollectorOptions {
  /** Path to the compiled collector binary. Defaults to the package-bundled binary. */
  binaryPath?: string;
  /** Called once per parsed focus event. */
  onEvent: (event: ActivityCollectorEvent) => void;
  /** Called once per parsed HID idle sample. Optional — safe to ignore. */
  onIdleSample?: (sample: ActivityCollectorIdleSample) => void;
  /** Called when the collector exits without a fatal failure. */
  onExit?: (exit: ActivityCollectorExit) => void;
  /** Called once per fatal collector error (process exit with non-zero, failed spawn, parse failure >5). */
  onFatal?: (reason: string) => void;
}

export interface ActivityCollectorExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  clean: boolean;
  reason: string;
}

export interface ActivityCollectorHandle {
  stop(): Promise<void>;
  readonly pid: number | null;
}

export function isSupportedPlatform(): boolean {
  return process.platform === "darwin";
}

function defaultBinaryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "native", "macos", "activity-collector");
}

type ParsedCollectorLine =
  | { kind: "event"; value: ActivityCollectorEvent }
  | { kind: "idle"; value: ActivityCollectorIdleSample }
  | { kind: "ignored" };

function parseCollectorLine(line: string): ParsedCollectorLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignored" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "ignored" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "ignored" };
  const p = parsed as Record<string, unknown>;
  const ts = typeof p.ts === "number" ? p.ts : NaN;
  if (!Number.isFinite(ts)) return { kind: "ignored" };
  if (p.event === "hid_idle") {
    const idleSeconds =
      typeof p.idleSeconds === "number" && Number.isFinite(p.idleSeconds)
        ? p.idleSeconds
        : null;
    if (idleSeconds === null) return { kind: "ignored" };
    return {
      kind: "idle",
      value: { ts, event: "hid_idle", idleSeconds },
    };
  }
  if (p.event !== "activate" && p.event !== "deactivate") {
    return { kind: "ignored" };
  }
  const bundleId = typeof p.bundleId === "string" ? p.bundleId : null;
  const appName = typeof p.appName === "string" ? p.appName : null;
  const windowTitle =
    typeof p.windowTitle === "string" ? p.windowTitle : undefined;
  if (bundleId === null || appName === null) {
    return { kind: "ignored" };
  }
  const out: ActivityCollectorEvent = {
    ts,
    event: p.event,
    bundleId,
    appName,
  };
  if (windowTitle !== undefined) out.windowTitle = windowTitle;
  return { kind: "event", value: out };
}

function parseEventLine(line: string): ActivityCollectorEvent | null {
  const parsed = parseCollectorLine(line);
  return parsed.kind === "event" ? parsed.value : null;
}

function describeCollectorExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): ActivityCollectorExit {
  return {
    code,
    signal,
    clean: code === 0 && signal === null,
    reason: `collector exited (code=${code}, signal=${signal})`,
  };
}

export function startActivityCollector(
  options: ActivityCollectorOptions,
): ActivityCollectorHandle {
  if (!isSupportedPlatform()) {
    throw new Error(
      `[activity-tracker] Native collector only runs on Darwin (current platform: ${process.platform}).`,
    );
  }

  const binary = options.binaryPath ?? defaultBinaryPath();
  if (!existsSync(binary)) {
    throw new Error(
      `[activity-tracker] Collector binary not found at ${binary}. Run 'bun run build:swift' in @elizaos/native-activity-tracker.`,
    );
  }

  const proc = spawn(binary, [], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stopped = false;

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const parsed = parseCollectorLine(line);
    if (parsed.kind === "event") {
      options.onEvent(parsed.value);
      return;
    }
    if (parsed.kind === "idle") {
      options.onIdleSample?.(parsed.value);
      return;
    }
    logger.debug(
      { line },
      "[activity-tracker] Ignored unparsable collector line",
    );
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0) {
      logger.warn({ stderr: text }, "[activity-tracker] Collector stderr");
    }
  });

  proc.on("error", (err) => {
    logger.error({ err }, "[activity-tracker] Collector spawn failure");
    options.onFatal?.(err.message);
  });

  proc.on("exit", (code, signal) => {
    if (stopped) return;
    const exit = describeCollectorExit(code, signal);
    if (exit.clean) {
      logger.info({ code, signal }, `[activity-tracker] ${exit.reason}`);
      options.onExit?.(exit);
      return;
    }
    logger.warn({ code, signal }, `[activity-tracker] ${exit.reason}`);
    options.onFatal?.(exit.reason);
  });

  return {
    get pid() {
      return proc.pid ?? null;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      rl.close();
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    },
  };
}

// Exposed for tests.
export const __internal = {
  parseEventLine,
  parseCollectorLine,
  describeCollectorExit,
};
