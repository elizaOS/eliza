/**
 * On-device inference memory policy for the in-process bun loader
 * (elizaOS/eliza#11760).
 *
 * The Pixel 6a forensics (#11506) showed lmkd killing the app at ~3.2 GB RSS
 * on a 5.7 GB-usable device because the loaded inference state is pinned for
 * as long as the process lives. The bionic GPU host applies the same policy in
 * Java (`InferenceMemoryPolicy.java` + `ElizaBionicInferenceServer`); this
 * module owns the bun-agent half for the non-delegated (in-process CPU/FFI)
 * path:
 *
 *   - **RAM-class classification** — `ELIZA_INFERENCE_RAM_CLASS` (exported by
 *     `ElizaAgentService` from `ActivityManager.getMemoryInfo().totalMem`)
 *     wins; otherwise `/proc/meminfo` `MemTotal` is read directly so
 *     non-Android AOSP-ish hosts (riscv64 boards) classify themselves.
 *   - **Idle unload** — `InferenceIdleUnloader` frees the loaded model after a
 *     RAM-class-dependent idle window (`ELIZA_LOCAL_IDLE_UNLOAD_MS` override,
 *     same env the desktop engine honours; `0` disables). The next request
 *     reloads through the existing `ensureChatLoaded` lifecycle, so nothing is
 *     lost beyond the reload latency.
 *
 * The thresholds mirror the Java side exactly — keep the two in sync.
 */

import { readFileSync } from "node:fs";
import {
  type InferenceRamClass,
  inferenceRamClassFromEnv,
} from "@elizaos/core";

export type { InferenceRamClass };

/**
 * Usable-RAM ceiling for the constrained class, MiB. 6 GB-nominal devices
 * report ~5.7 GiB usable (Pixel 6a, the #11506 device); 8 GB-nominal devices
 * report ~7.3-7.75 GiB. 7 GiB separates the two. Mirrors
 * `InferenceMemoryPolicy.CONSTRAINED_MAX_TOTAL_RAM_BYTES`.
 */
export const CONSTRAINED_MAX_TOTAL_RAM_MB = 7 * 1024;

/** Idle-unload defaults by class, ms. Mirrors the Java policy. */
export const CONSTRAINED_IDLE_UNLOAD_MS = 5 * 60_000;
export const STANDARD_IDLE_UNLOAD_MS = 30 * 60_000;

/** Cadence of the idle check. */
export const IDLE_UNLOAD_CHECK_INTERVAL_MS = 60_000;

/**
 * MemAvailable fraction below which the resident model is released under
 * pressure, by class. The bun agent process never receives `onTrimMemory`
 * (it is not an Android component), so `/proc/meminfo` MemAvailable is its
 * pressure signal. Constrained devices act early (lmkd's PSI killer moves
 * fast on a 5.7 GB device once ambient apps are resident); standard devices
 * only act at genuinely critical levels. Fractions mirror the low/critical
 * watermarks of the desktop `nodeOsPressureSource`.
 */
export const CONSTRAINED_PRESSURE_RELEASE_FRACTION = 0.12;
export const STANDARD_PRESSURE_RELEASE_FRACTION = 0.05;

/** Parse `MemTotal` (kB) out of /proc/meminfo text. Returns MiB, or null. */
export function parseMemTotalMb(meminfoText: string): number | null {
  return parseMeminfoFieldMb(meminfoText, "MemTotal");
}

/** Parse `MemAvailable` (kB) out of /proc/meminfo text. Returns MiB, or null. */
export function parseMemAvailableMb(meminfoText: string): number | null {
  return parseMeminfoFieldMb(meminfoText, "MemAvailable");
}

function parseMeminfoFieldMb(
  meminfoText: string,
  field: "MemTotal" | "MemAvailable",
): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(meminfoText);
  if (!match) return null;
  const kb = Number.parseInt(match[1], 10);
  if (!Number.isFinite(kb) || kb <= 0) return null;
  return Math.round(kb / 1024);
}

function readProcMeminfo(): string | null {
  try {
    return readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null; // not a Linux host — callers fall back to standard/no-pressure
  }
}

function readProcMemTotalMb(): number | null {
  const text = readProcMeminfo();
  return text == null ? null : parseMemTotalMb(text);
}

/**
 * Pure pressure decision: release when MemAvailable falls below the class
 * fraction of MemTotal. Unreadable probes never release — a broken probe must
 * not evict a healthy model.
 */
export function shouldReleaseForMemAvailable(
  ramClass: InferenceRamClass,
  availableMb: number | null,
  totalMb: number | null,
): boolean {
  if (availableMb == null || totalMb == null || totalMb <= 0) return false;
  const fraction =
    ramClass === "constrained"
      ? CONSTRAINED_PRESSURE_RELEASE_FRACTION
      : STANDARD_PRESSURE_RELEASE_FRACTION;
  return availableMb / totalMb < fraction;
}

/**
 * Build the /proc/meminfo-backed pressure check for
 * {@link InferenceIdleUnloader}. Returns a description string when the
 * resident model should be released right now, else null.
 */
export function makeProcMeminfoPressureCheck(
  ramClass: InferenceRamClass,
  readMeminfo: () => string | null = readProcMeminfo,
): () => string | null {
  return () => {
    const text = readMeminfo();
    if (text == null) return null;
    const availableMb = parseMemAvailableMb(text);
    const totalMb = parseMemTotalMb(text);
    if (!shouldReleaseForMemAvailable(ramClass, availableMb, totalMb)) {
      return null;
    }
    return `MemAvailable=${availableMb}MB / MemTotal=${totalMb}MB (ramClass=${ramClass})`;
  };
}

/**
 * Classify this host's inference RAM class. Precedence:
 *   1. `ELIZA_INFERENCE_RAM_CLASS` env ("constrained" / "standard") — set by
 *      `ElizaAgentService` on Android, or by an operator.
 *   2. `totalRamMb` when the caller already probed (tests, diagnostics).
 *   3. `/proc/meminfo` MemTotal.
 * An unreadable probe classifies "standard" — a broken probe must not degrade
 * a healthy host to the constrained profile.
 */
export function classifyInferenceRamClass(
  env: NodeJS.ProcessEnv = process.env,
  totalRamMb?: number,
): InferenceRamClass {
  const override = inferenceRamClassFromEnv(env);
  if (override !== null) return override;
  const total = totalRamMb ?? readProcMemTotalMb();
  if (total == null || total <= 0) return "standard";
  return total < CONSTRAINED_MAX_TOTAL_RAM_MB ? "constrained" : "standard";
}

/**
 * Resolve the idle-unload window. `ELIZA_LOCAL_IDLE_UNLOAD_MS` wins when it
 * parses to a non-negative integer (`0` disables); otherwise the RAM-class
 * default applies.
 */
export function resolveInferenceIdleUnloadMs(
  ramClass: InferenceRamClass,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ELIZA_LOCAL_IDLE_UNLOAD_MS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return ramClass === "constrained"
    ? CONSTRAINED_IDLE_UNLOAD_MS
    : STANDARD_IDLE_UNLOAD_MS;
}

export type IdleUnloadTickResult =
  | "disabled"
  | "not-loaded"
  | "in-use"
  | "warm"
  | "unloaded"
  | "pressure-unloaded"
  | "unload-failed";

export interface InferenceIdleUnloaderOptions {
  /** Idle window, ms. `0` disables the idle lever (pressure stays active). */
  idleUnloadMs: number;
  /** True while model weights are actually resident. */
  isLoaded: () => boolean;
  /** Free the weights (loader.unloadModel + lifecycle.markEvicted). */
  unload: () => Promise<void>;
  /**
   * Optional pressure check ({@link makeProcMeminfoPressureCheck}): returns a
   * description string when the model should be released right now regardless
   * of idle time, else null. Checked after the idle window on every tick.
   */
  pressureCheck?: () => string | null;
  /** Check cadence, ms. Defaults to {@link IDLE_UNLOAD_CHECK_INTERVAL_MS}. */
  checkIntervalMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

/**
 * Idle unloader for the in-process loader. Use `beginUse()` around every
 * loader call that touches the model (load/generate/embed); the returned
 * function marks the use complete and refreshes the idle clock. `tick()` frees
 * the model when it has been loaded, unused, and idle past the window — never
 * while a use is in flight.
 */
export class InferenceIdleUnloader {
  private readonly idleUnloadMs: number;
  private readonly isLoaded: () => boolean;
  private readonly unload: () => Promise<void>;
  private readonly pressureCheck: (() => string | null) | null;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: InferenceIdleUnloaderOptions["logger"];

  private lastUsedAtMs: number;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private unloading = false;

  constructor(opts: InferenceIdleUnloaderOptions) {
    this.idleUnloadMs = opts.idleUnloadMs;
    this.isLoaded = opts.isLoaded;
    this.unload = opts.unload;
    this.pressureCheck = opts.pressureCheck ?? null;
    this.checkIntervalMs = Math.max(
      1_000,
      opts.checkIntervalMs ?? IDLE_UNLOAD_CHECK_INTERVAL_MS,
    );
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger;
    this.lastUsedAtMs = this.now();
  }

  /** Arm the periodic check. No-op when neither lever is configured. */
  start(): void {
    if ((this.idleUnloadMs <= 0 && !this.pressureCheck) || this.timer) return;
    const t = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger?.warn(
          `[aosp-local-inference] idle-unload tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.checkIntervalMs);
    t.unref();
    this.timer = t;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Mark a model use in flight. Call the returned function when the use
   * completes (success or failure) — it decrements the in-flight count and
   * refreshes the idle clock.
   */
  beginUse(): () => void {
    this.inFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastUsedAtMs = this.now();
    };
  }

  idleMs(): number {
    return this.now() - this.lastUsedAtMs;
  }

  /** One idle/pressure check. Exposed for tests; the armed timer calls this. */
  async tick(): Promise<IdleUnloadTickResult> {
    if (this.idleUnloadMs <= 0 && !this.pressureCheck) return "disabled";
    if (this.inFlight > 0 || this.unloading) return "in-use";
    if (!this.isLoaded()) return "not-loaded";
    const idle = this.idleMs();
    if (this.idleUnloadMs > 0 && idle >= this.idleUnloadMs) {
      return this.runUnload(
        `after ${idle}ms idle (>= ${this.idleUnloadMs}ms)`,
        "unloaded",
      );
    }
    const pressure = this.pressureCheck?.() ?? null;
    if (pressure != null) {
      return this.runUnload(
        `under memory pressure: ${pressure}`,
        "pressure-unloaded",
      );
    }
    return "warm";
  }

  private async runUnload(
    reason: string,
    result: "unloaded" | "pressure-unloaded",
  ): Promise<IdleUnloadTickResult> {
    this.unloading = true;
    try {
      await this.unload();
      this.logger?.info(
        `[aosp-local-inference] released the local model ${reason}; next request reloads on demand (#11760)`,
      );
      return result;
    } catch (err) {
      this.logger?.warn(
        `[aosp-local-inference] model release failed (stays resident): ${err instanceof Error ? err.message : String(err)}`,
      );
      return "unload-failed";
    } finally {
      this.unloading = false;
    }
  }
}
