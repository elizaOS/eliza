/**
 * Persistent boot + memory telemetry recorder.
 *
 * Boot phase timings (from {@link BootTimer.getSummary}) and a periodic RSS
 * sampler are written as JSON under `<stateDir>/telemetry/` so runtime
 * performance can be analyzed over time rather than only tailed from logs.
 *
 * Telemetry is best-effort and must never affect boot: only the filesystem
 * writes are guarded, and a failed write logs a single warning. It is disabled
 * entirely under tests and when `ELIZA_DISABLE_TELEMETRY=1`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { logger } from "@elizaos/core";
import { isDevApiWatchEnabled } from "@elizaos/shared/runtime-env";

import { resolveStateDir } from "../config/paths.ts";
import type { BootSummary } from "./boot-timer.ts";

const BOOT_DIR = "boot";
const MEMORY_DIR = "memory";
const RESTART_DIR = "restart";
const LATEST_FILE = "latest.json";
const RESTART_EVENTS_FILE = "events.json";
const STARTUP_TRACE_ID_ENV = "ELIZA_STARTUP_TRACE_ID";
/** Keep at most this many of the most recent RSS samples on disk. */
const MAX_SAMPLES = 240;
/** Keep at most this many recent boot/(re)start events on disk. */
const MAX_RESTART_EVENTS = 200;

/** Node `process.memoryUsage()` snapshot, in bytes. */
interface MemoryUsageSnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

/** Boot summary enriched with the process state at record time. */
interface BootTelemetryRecord extends BootSummary {
  /** Host/renderer correlation id when the native shell provided one. */
  traceId?: string;
  /** ISO-8601 timestamp the record was written. */
  recordedAt: string;
  /** `process.uptime()` in seconds at record time. */
  processUptimeSec: number;
  /** Memory usage at record time, in bytes. */
  memory: MemoryUsageSnapshot;
}

/** A single RSS sample. */
interface MemorySample {
  /** Epoch milliseconds when the sample was taken. */
  at: number;
  /** Resident set size at sample time, in megabytes. */
  rssMb: number;
}

/** On-disk shape of the memory sampler's `latest.json`. */
interface MemoryTelemetryRecord {
  /** Peak observed RSS across the run, in megabytes. */
  peakRssMb: number;
  /** Epoch milliseconds when sampling started. */
  startedAt: number;
  /** Most recent samples, capped at {@link MAX_SAMPLES}. */
  samples: MemorySample[];
}

/** True when telemetry should not run (tests or explicit opt-out). */
function telemetryDisabled(): boolean {
  return (
    process.env.ELIZA_DISABLE_TELEMETRY === "1" ||
    process.env.NODE_ENV === "test"
  );
}

function captureMemory(): MemoryUsageSnapshot {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

function telemetryDir(...segments: string[]): string {
  return path.join(resolveStateDir(), "telemetry", ...segments);
}

function readStartupTraceId(): string | undefined {
  const value = process.env[STARTUP_TRACE_ID_ENV];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Write `data` as pretty JSON to `<stateDir>/telemetry/<dir>/<file>`, creating
 * the directory tree first. Only the filesystem work is guarded; a failure logs
 * a single warning and is otherwise swallowed so telemetry never breaks boot.
 */
async function writeTelemetryFile(
  dir: string,
  file: string,
  data: unknown,
): Promise<void> {
  const targetDir = telemetryDir(dir);
  const targetPath = path.join(targetDir, file);
  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    // error-policy:J7 telemetry failure is warned but cannot kill runtime boot.
    logger.warn(
      `[boot-telemetry] Failed to write ${targetPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Persist a boot run: enrich the boot summary with process memory + uptime and
 * write a timestamped record plus `latest.json` under
 * `<stateDir>/telemetry/boot/`. Returns immediately when telemetry is disabled.
 * Resolves once the write completes (or fails safely); callers should `void` it
 * after boot so it never delays readiness.
 */
export async function recordBootTelemetry(summary: BootSummary): Promise<void> {
  if (telemetryDisabled()) {
    return;
  }

  const recordedAt = new Date().toISOString();
  const startupTraceId = readStartupTraceId();
  const record: BootTelemetryRecord = {
    ...summary,
    ...(startupTraceId ? { traceId: startupTraceId } : {}),
    recordedAt,
    processUptimeSec: process.uptime(),
    memory: captureMemory(),
  };

  const fileName = `${recordedAt.replace(/[:.]/g, "-")}.json`;
  await Promise.all([
    writeTelemetryFile(BOOT_DIR, fileName, record),
    writeTelemetryFile(BOOT_DIR, LATEST_FILE, record),
  ]);
}

/** A single boot/(re)start event — one is appended at the start of each boot. */
interface BootEvent {
  /** Host/renderer correlation id when the native shell provided one. */
  traceId?: string;
  /** Epoch milliseconds when the boot began. */
  at: number;
  /** OS pid of the booting process. */
  pid: number;
  /** Supervisor spawn timestamp, when known (restart-correlation key). */
  spawnedAtMs: number | null;
  /** True when the API is running under an active dev watcher. */
  watch: boolean;
  /** Short label, e.g. the BootTimer label. */
  label: string;
}

/**
 * Append a boot/(re)start event to
 * `<stateDir>/telemetry/restart/events.json` (a bounded rolling array). Unlike
 * {@link recordBootTelemetry}, which only fires once a boot *completes*, this is
 * called at the very start of every boot, so a restart storm — where boots never
 * finish — is still countable. The dev boot-history endpoint surfaces the array
 * so an operator can see restart cadence. Best-effort; never throws, never
 * delays boot (callers should `void` it). Returns immediately when telemetry is
 * disabled.
 */
export async function recordBootEvent(label: string): Promise<void> {
  if (telemetryDisabled()) {
    return;
  }

  const spawnedAtMs = Number(process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS);
  const startupTraceId = readStartupTraceId();
  const event: BootEvent = {
    ...(startupTraceId ? { traceId: startupTraceId } : {}),
    at: Date.now(),
    pid: process.pid,
    spawnedAtMs:
      Number.isFinite(spawnedAtMs) && spawnedAtMs > 0 ? spawnedAtMs : null,
    watch: isDevApiWatchEnabled(),
    label,
  };

  const targetDir = telemetryDir(RESTART_DIR);
  const targetPath = path.join(targetDir, RESTART_EVENTS_FILE);
  try {
    await fs.mkdir(targetDir, { recursive: true });
    let events: BootEvent[] = [];
    let existing: string | null;
    try {
      existing = await fs.readFile(targetPath, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      // error-policy:J3 absence is the only valid empty-history signal.
      existing = null;
    }
    if (existing !== null) {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (Array.isArray(parsed)) {
          events = parsed as BootEvent[];
        } else {
          logger.warn(
            `[boot-telemetry] Ignoring invalid restart history in ${targetPath}: expected an array`,
          );
        }
      } catch (error) {
        // error-policy:J3 corrupt local telemetry is explicit before replacement.
        logger.warn(
          `[boot-telemetry] Replacing invalid restart history in ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        events = [];
      }
    }
    events.push(event);
    if (events.length > MAX_RESTART_EVENTS) {
      events.splice(0, events.length - MAX_RESTART_EVENTS);
    }
    await fs.writeFile(targetPath, `${JSON.stringify(events, null, 2)}\n`);
  } catch (err) {
    // error-policy:J7 telemetry failure is warned but cannot kill runtime boot.
    logger.warn(
      `[boot-telemetry] Failed to record boot event: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Options for {@link startMemorySampler}. */
export interface MemorySamplerOptions {
  /** Sampling interval in milliseconds. */
  intervalMs: number;
}

interface MemorySamplerHandle {
  timer: NodeJS.Timeout;
  detach: () => Promise<void>;
}

let activeSampler: MemorySamplerHandle | null = null;

/**
 * Begin periodically sampling `process.memoryUsage().rss`, tracking the peak.
 * On `beforeExit` (or {@link stopMemorySampler}) the run is flushed to
 * `<stateDir>/telemetry/memory/latest.json`. The interval is `unref()`'d so it
 * never keeps the process alive. Signal ownership stays with the host: a
 * telemetry-only SIGTERM listener would suppress the platform's default
 * termination behavior. Returns immediately when telemetry is disabled or a
 * sampler is already running.
 */
export function startMemorySampler(options: MemorySamplerOptions): void {
  if (telemetryDisabled() || activeSampler) {
    return;
  }

  const startedAt = Date.now();
  const samples: MemorySample[] = [];
  let peakRssBytes = 0;

  const sample = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) {
      peakRssBytes = rss;
    }
    samples.push({ at: Date.now(), rssMb: bytesToMb(rss) });
    if (samples.length > MAX_SAMPLES) {
      samples.splice(0, samples.length - MAX_SAMPLES);
    }
  };

  sample();
  const timer = setInterval(sample, options.intervalMs);
  timer.unref();

  let flushPromise: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    if (flushPromise) return flushPromise;
    const record: MemoryTelemetryRecord = {
      peakRssMb: bytesToMb(peakRssBytes),
      startedAt,
      samples: [...samples],
    };
    const pending = writeTelemetryFile(MEMORY_DIR, LATEST_FILE, record).finally(
      () => {
        if (flushPromise === pending) flushPromise = null;
      },
    );
    flushPromise = pending;
    return flushPromise;
  };

  const onExit = (): void => {
    // Async work scheduled from `beforeExit` causes Node/Bun to emit
    // `beforeExit` again once that work settles. Detach first so the final
    // telemetry write cannot create an infinite exit/write loop.
    process.off("beforeExit", onExit);
    void flush();
  };

  process.on("beforeExit", onExit);

  activeSampler = {
    timer,
    detach: async () => {
      clearInterval(timer);
      process.off("beforeExit", onExit);
      await flush();
    },
  };
}

/** Stop the active memory sampler and flush a final snapshot to disk. */
export async function stopMemorySampler(): Promise<void> {
  if (!activeSampler) {
    return;
  }
  const handle = activeSampler;
  activeSampler = null;
  await handle.detach();
}
