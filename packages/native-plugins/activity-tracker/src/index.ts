/**
 * Native activity-tracker driver.
 *
 * Spawns the compiled macOS `activity-collector` helper and exposes a typed
 * event stream of window/app focus transitions. Non-Darwin platforms are
 * unsupported — callers must check {@link isSupportedPlatform} and degrade.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
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

export interface ActivityCollectorOptions {
  /** Path to the compiled collector binary. Defaults to the package-bundled binary. */
  binaryPath?: string;
  /** Called once per parsed event. */
  onEvent: (event: ActivityCollectorEvent) => void;
  /** Called once per fatal collector error (process exit with non-zero, failed spawn, parse failure >5). */
  onFatal?: (reason: string) => void;
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

function parseEventLine(line: string): ActivityCollectorEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const ts = typeof p.ts === "number" ? p.ts : NaN;
  const event = p.event === "activate" || p.event === "deactivate" ? p.event : null;
  const bundleId = typeof p.bundleId === "string" ? p.bundleId : null;
  const appName = typeof p.appName === "string" ? p.appName : null;
  const windowTitle = typeof p.windowTitle === "string" ? p.windowTitle : undefined;
  if (!Number.isFinite(ts) || event === null || bundleId === null || appName === null) {
    return null;
  }
  const out: ActivityCollectorEvent = { ts, event, bundleId, appName };
  if (windowTitle !== undefined) out.windowTitle = windowTitle;
  return out;
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
    const parsed = parseEventLine(line);
    if (!parsed) {
      logger.debug({ line }, "[activity-tracker] Ignored unparsable collector line");
      return;
    }
    options.onEvent(parsed);
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
    const reason = `collector exited (code=${code}, signal=${signal})`;
    logger.warn({ code, signal }, `[activity-tracker] ${reason}`);
    options.onFatal?.(reason);
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
export const __internal = { parseEventLine };
