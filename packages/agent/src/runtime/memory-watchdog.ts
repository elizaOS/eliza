/**
 * Memory watchdog — proactively bounce the runtime before an OOM kill.
 *
 * The boot telemetry sampler ({@link ./boot-telemetry.ts}) records RSS but never
 * acts on it: a slow leak ends in an OS OOM kill, not a clean restart. This
 * watchdog closes that gap. When RSS stays at/above a configured threshold for a
 * sustained number of samples it logs a structured `[MemoryWatchdog]` warning and
 * requests a CLEAN restart through the existing {@link requestRestart} seam — the
 * host's registered handler exits with `RESTART_EXIT_CODE` (75) and the
 * `run-node.mjs` supervisor relaunches. It never calls `process.exit` itself and
 * never introduces a second restart mechanism.
 *
 * Opt-in and thresholds are env-configured (documented in
 * `packages/agent/CLAUDE.md`):
 *
 * | Env var                              | Default | Meaning                                   |
 * | ------------------------------------ | ------- | ----------------------------------------- |
 * | `ELIZA_MEMORY_WATCHDOG`              | off     | `1`/`true` enables the watchdog           |
 * | `ELIZA_MEMORY_WATCHDOG_RSS_MB`       | `1536`  | RSS restart threshold, megabytes          |
 * | `ELIZA_MEMORY_WATCHDOG_INTERVAL_MS`  | `30000` | sample interval, milliseconds             |
 * | `ELIZA_MEMORY_WATCHDOG_SUSTAINED`    | `3`     | consecutive over-threshold samples needed |
 *
 * The sustained-sample requirement debounces transient allocation spikes (a GC
 * cycle, a one-off large request) so only a genuine, persistent climb triggers a
 * restart.
 *
 * @module memory-watchdog
 */
import process from "node:process";

import { logger } from "@elizaos/core";
import { requestRestart } from "@elizaos/shared";

const BYTES_PER_MB = 1024 * 1024;

const DEFAULT_RSS_THRESHOLD_MB = 1536;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SUSTAINED_SAMPLES = 3;

/** Floors that keep an obviously-misconfigured env from bouncing the process instantly. */
const MIN_THRESHOLD_MB = 128;
const MIN_INTERVAL_MS = 1_000;
const MIN_SUSTAINED_SAMPLES = 1;

/** Resolved, validated watchdog configuration. */
export interface MemoryWatchdogConfig {
  /** RSS threshold in megabytes; at/above this for the sustained window → restart. */
  rssThresholdMb: number;
  /** Sampling interval in milliseconds. */
  intervalMs: number;
  /** Consecutive over-threshold samples required before requesting a restart. */
  sustainedSamples: number;
}

/** Injected dependencies — real ones in production, fakes in tests. */
export interface MemoryWatchdogDeps {
  /** Returns current resident set size in bytes. */
  readRssBytes: () => number;
  /** Request a clean restart through the host's registered handler. */
  requestRestart: (reason?: string) => void | Promise<void>;
  /** Structured logger (only `warn`/`info` are used). */
  log: Pick<typeof logger, "warn" | "info">;
}

export interface MemoryWatchdog {
  /** Evaluate a single sample. Returns `true` when this tick requested a restart. */
  tick: () => boolean;
  /** Begin periodic sampling. The interval is `unref()`'d so it never keeps the process alive. */
  start: () => void;
  /** Stop periodic sampling. */
  stop: () => void;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  if (raw == null) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

/** True when `ELIZA_MEMORY_WATCHDOG` is explicitly enabled. Default: disabled. */
export function isMemoryWatchdogEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.ELIZA_MEMORY_WATCHDOG;
  return value === "1" || value === "true";
}

/** Resolve a validated config from the environment (or a provided env map for tests). */
export function resolveMemoryWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemoryWatchdogConfig {
  return {
    rssThresholdMb: parsePositiveInt(
      env.ELIZA_MEMORY_WATCHDOG_RSS_MB,
      DEFAULT_RSS_THRESHOLD_MB,
      MIN_THRESHOLD_MB,
    ),
    intervalMs: parsePositiveInt(
      env.ELIZA_MEMORY_WATCHDOG_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
    ),
    sustainedSamples: parsePositiveInt(
      env.ELIZA_MEMORY_WATCHDOG_SUSTAINED,
      DEFAULT_SUSTAINED_SAMPLES,
      MIN_SUSTAINED_SAMPLES,
    ),
  };
}

/**
 * Construct a watchdog around injected dependencies. Pure and side-effect-free
 * until {@link MemoryWatchdog.tick}/{@link MemoryWatchdog.start} is called, which
 * makes the threshold/debounce/one-shot logic directly unit-testable without a
 * real process, timer, or restart handler.
 */
export function createMemoryWatchdog(
  config: MemoryWatchdogConfig,
  deps: MemoryWatchdogDeps,
): MemoryWatchdog {
  const thresholdBytes = config.rssThresholdMb * BYTES_PER_MB;
  let consecutiveOver = 0;
  let triggered = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): boolean => {
    // One-shot: once a restart is requested, stop sampling/acting. The supervisor
    // owns what happens next; re-requesting would spam the handler.
    if (triggered) return false;

    const rss = deps.readRssBytes();
    if (rss < thresholdBytes) {
      consecutiveOver = 0;
      return false;
    }

    consecutiveOver += 1;
    if (consecutiveOver < config.sustainedSamples) {
      return false;
    }

    triggered = true;
    const rssMb = Math.round(rss / BYTES_PER_MB);
    const reason = `memory-watchdog: RSS ${rssMb}MB >= ${config.rssThresholdMb}MB for ${consecutiveOver} samples`;
    deps.log.warn(
      `[MemoryWatchdog] ${reason} — requesting clean restart via supervisor`,
    );
    void deps.requestRestart(reason);
    return true;
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(tick, config.intervalMs);
    // Never let the watchdog timer keep the event loop alive on its own.
    timer.unref?.();
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { tick, start, stop };
}

let active: MemoryWatchdog | null = null;

/**
 * Start the process-wide memory watchdog if `ELIZA_MEMORY_WATCHDOG` is enabled.
 * Wires the real RSS source, the real {@link requestRestart} seam, and the
 * structured logger. Returns the running watchdog, or `null` when disabled or
 * already running. Safe to call once during boot.
 */
export function startMemoryWatchdog(
  env: NodeJS.ProcessEnv = process.env,
): MemoryWatchdog | null {
  if (active) return active;
  if (!isMemoryWatchdogEnabled(env)) return null;

  const config = resolveMemoryWatchdogConfig(env);
  const watchdog = createMemoryWatchdog(config, {
    readRssBytes: () => process.memoryUsage().rss,
    requestRestart,
    log: logger,
  });
  watchdog.start();
  active = watchdog;
  logger.info(
    `[MemoryWatchdog] enabled (threshold ${config.rssThresholdMb}MB, interval ${config.intervalMs}ms, sustained ${config.sustainedSamples} samples)`,
  );
  return watchdog;
}

/** Stop the process-wide memory watchdog, if one is running. */
export function stopMemoryWatchdog(): void {
  if (!active) return;
  active.stop();
  active = null;
}
