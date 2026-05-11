/**
 * RAM-pressure monitor for the local-inference path (W10 / J2).
 *
 * Polls `os.freemem()` / `os.totalmem()` on an interval (and, when the
 * dflash llama-server is running, scrapes its `/metrics` RSS so a runaway
 * server process is visible even when the OS hasn't yet reported low free
 * RAM). When free RAM crosses a low-water threshold, the monitor walks the
 * `SharedResourceRegistry`'s evictable model roles in *ascending priority*
 * — `drafter < vision/mmproj < embedding < vad < ASR < TTS < text-target` —
 * and evicts the cheapest one. Cheap evictions are the voice TTS/ASR weights
 * (`MmapRegionHandle.evictPages()`), the vision projector, and unloading the
 * embedding model; the DFlash drafter is co-resident in the llama-server
 * process, so "evicting" it means restarting the server without `-md` — that
 * role registers a high enough priority that it's only chosen as a last
 * resort. Every eviction is logged (observable) and reversible (roles re-load
 * lazily on next use).
 *
 * The monitor never *loads* anything — it only frees memory. Re-load is the
 * caller's job, on demand. It also never evicts the text target (priority
 * 100) unless it's literally the only resident role and pressure persists,
 * which is the intended "nothing left to give" behaviour.
 *
 * No fallback sludge: when there is nothing to evict and pressure persists,
 * the monitor logs a warning and stops trying for a back-off window — it does
 * not pretend it fixed anything.
 */

import os from "node:os";
import type {
  ResidentModelRole,
  SharedResourceRegistry,
} from "./voice/shared-resources";

/** Minimal structural logger — keeps this module dependency-free. */
export interface MemoryMonitorLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

export interface MemorySample {
  totalMb: number;
  freeMb: number;
  /** llama-server RSS in MB when the dflash backend exposes it, else null. */
  serverRssMb: number | null;
  /** Effective free memory used for the pressure decision (min of OS-free and total-minus-RSS-style headroom). */
  effectiveFreeMb: number;
  /** Free as a fraction of total (0..1), based on `effectiveFreeMb`. */
  freeFraction: number;
}

export interface MemoryMonitorConfig {
  /** Poll interval, ms. Default 30 s; min 1 s. */
  intervalMs: number;
  /**
   * Evict when free RAM drops below `max(lowWaterMb, lowWaterFraction*total)`.
   * Defaults: 768 MB / 8% of total.
   */
  lowWaterMb: number;
  lowWaterFraction: number;
  /**
   * After an eviction, wait this long before the next eviction so the OS
   * has time to reflect the reclaimed pages. Default 5 s.
   */
  evictionCooldownMs: number;
  /**
   * After "nothing left to evict", back off for this long before warning
   * again. Default 60 s.
   */
  exhaustedBackoffMs: number;
}

const DEFAULT_CONFIG: MemoryMonitorConfig = {
  intervalMs: 30_000,
  lowWaterMb: 768,
  lowWaterFraction: 0.08,
  evictionCooldownMs: 5_000,
  exhaustedBackoffMs: 60_000,
};

const BYTES_PER_MB = 1024 * 1024;

function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function envFloat(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : undefined;
}

export function resolveMemoryMonitorConfig(
  overrides: Partial<MemoryMonitorConfig> = {},
): MemoryMonitorConfig {
  const intervalMs = Math.max(
    1_000,
    overrides.intervalMs ??
      envInt("ELIZA_LOCAL_MEMORY_MONITOR_INTERVAL_MS") ??
      DEFAULT_CONFIG.intervalMs,
  );
  return {
    intervalMs,
    lowWaterMb:
      overrides.lowWaterMb ??
      envInt("ELIZA_LOCAL_MEMORY_LOW_WATER_MB") ??
      DEFAULT_CONFIG.lowWaterMb,
    lowWaterFraction:
      overrides.lowWaterFraction ??
      envFloat("ELIZA_LOCAL_MEMORY_LOW_WATER_FRACTION") ??
      DEFAULT_CONFIG.lowWaterFraction,
    evictionCooldownMs: Math.max(
      0,
      overrides.evictionCooldownMs ?? DEFAULT_CONFIG.evictionCooldownMs,
    ),
    exhaustedBackoffMs: Math.max(
      0,
      overrides.exhaustedBackoffMs ?? DEFAULT_CONFIG.exhaustedBackoffMs,
    ),
  };
}

/** Pluggable sources so the monitor stays unit-testable without OS state. */
export interface MemoryMonitorSources {
  /** OS free/total memory in bytes. Defaults to `os.freemem()/os.totalmem()`. */
  osMemory?: () => { freeBytes: number; totalBytes: number };
  /** Running llama-server RSS in MB, or null. Defaults to the dflash backend probe. */
  serverRssMb?: () => Promise<number | null>;
}

export interface MemoryPressureAction {
  sample: MemorySample;
  /** What got evicted this tick, if anything. */
  evicted: { id: string; role: ResidentModelRole; estimatedMb: number } | null;
  /** True when pressure was detected but nothing could be evicted. */
  exhausted: boolean;
}

export class MemoryMonitor {
  private readonly config: MemoryMonitorConfig;
  private readonly registry: SharedResourceRegistry;
  private readonly log?: MemoryMonitorLogger;
  private readonly osMemory: () => { freeBytes: number; totalBytes: number };
  private readonly serverRssMb: () => Promise<number | null>;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastEvictionAtMs = 0;
  private exhaustedUntilMs = 0;

  constructor(args: {
    registry: SharedResourceRegistry;
    config?: Partial<MemoryMonitorConfig>;
    logger?: MemoryMonitorLogger;
    sources?: MemoryMonitorSources;
  }) {
    this.registry = args.registry;
    this.config = resolveMemoryMonitorConfig(args.config);
    this.log = args.logger;
    this.osMemory =
      args.sources?.osMemory ??
      (() => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }));
    this.serverRssMb =
      args.sources?.serverRssMb ?? (async () => defaultServerRssMb());
  }

  /** Begin polling. Idempotent. The interval is unref'd so it never holds the process open. */
  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log?.warn?.(
          `[MemoryMonitor] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.config.intervalMs);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the polling timer is running. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Take a memory sample now (no side effects). */
  async sample(): Promise<MemorySample> {
    const { freeBytes, totalBytes } = this.osMemory();
    const totalMb = Math.round(totalBytes / BYTES_PER_MB);
    const freeMb = Math.round(freeBytes / BYTES_PER_MB);
    const serverRssMb = await this.serverRssMb().catch(() => null);
    // If the server process is huge relative to total RAM, treat the
    // headroom (total - RSS - what other things need) as a tighter free
    // estimate than the OS free figure alone. We approximate "what other
    // things need" by the configured low-water reserve so this only kicks
    // in when the server itself is the problem.
    const reserveMb = Math.max(
      this.config.lowWaterMb,
      Math.round(totalMb * this.config.lowWaterFraction),
    );
    const serverHeadroomMb =
      serverRssMb !== null
        ? totalMb - serverRssMb - reserveMb
        : Number.POSITIVE_INFINITY;
    const effectiveFreeMb = Math.min(freeMb, serverHeadroomMb);
    const freeFraction = totalMb > 0 ? effectiveFreeMb / totalMb : 1;
    return { totalMb, freeMb, serverRssMb, effectiveFreeMb, freeFraction };
  }

  /** Low-water line for the current sample, in MB. */
  private lowWaterMb(totalMb: number): number {
    return Math.max(
      this.config.lowWaterMb,
      Math.round(totalMb * this.config.lowWaterFraction),
    );
  }

  isUnderPressure(sample: MemorySample): boolean {
    return sample.effectiveFreeMb < this.lowWaterMb(sample.totalMb);
  }

  /**
   * One monitor step: sample, and if under pressure (and not in cooldown),
   * evict the lowest-priority resident role. Returns what it did so callers
   * (and tests) can assert. Public so tests don't have to wait on a timer.
   */
  async tick(now: number = Date.now()): Promise<MemoryPressureAction> {
    if (this.ticking) {
      const sample = await this.sample();
      return { sample, evicted: null, exhausted: false };
    }
    this.ticking = true;
    try {
      const sample = await this.sample();
      if (!this.isUnderPressure(sample)) {
        this.exhaustedUntilMs = 0;
        return { sample, evicted: null, exhausted: false };
      }
      if (now - this.lastEvictionAtMs < this.config.evictionCooldownMs) {
        return { sample, evicted: null, exhausted: false };
      }
      const evicted = await this.registry.evictLowestPriorityRole();
      if (evicted) {
        this.lastEvictionAtMs = now;
        this.exhaustedUntilMs = 0;
        this.log?.info?.(
          `[MemoryMonitor] RAM pressure (free ${sample.effectiveFreeMb} MB < ${this.lowWaterMb(sample.totalMb)} MB low-water) — evicted ${evicted.role} (~${evicted.estimatedMb} MB)`,
        );
        return { sample, evicted, exhausted: false };
      }
      // Nothing evictable. Warn (back-off so we don't spam the log).
      if (now >= this.exhaustedUntilMs) {
        this.exhaustedUntilMs = now + this.config.exhaustedBackoffMs;
        this.log?.warn?.(
          `[MemoryMonitor] RAM pressure (free ${sample.effectiveFreeMb} MB) but no evictable model role — only the text target is resident. Consider a smaller tier (ELIZA_LOCAL_RAM_HEADROOM_MB / model selection).`,
        );
      }
      return { sample, evicted: null, exhausted: true };
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Default llama-server RSS probe: scrape the dflash backend's `/metrics`
 * for `process_resident_memory_bytes` (the standard Prometheus process
 * collector gauge llama-server exports). Returns null when no server is
 * running or the gauge isn't present. Inline import keeps `memory-monitor`
 * loadable without dragging the whole engine in at module-load time and
 * avoids a static cycle (dflash-server → conversation-registry → ... → here).
 */
async function defaultServerRssMb(): Promise<number | null> {
  try {
    const { dflashLlamaServer } = await import("./dflash-server");
    if (!dflashLlamaServer.hasLoadedModel()) return null;
    const baseUrl = dflashLlamaServer.currentBaseUrl();
    if (!baseUrl) return null;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`, {
      method: "GET",
    });
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/^process_resident_memory_bytes\s+([0-9.eE+-]+)/m);
    if (!match) return null;
    const bytes = Number.parseFloat(match[1]);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.round(bytes / BYTES_PER_MB);
  } catch {
    return null;
  }
}
