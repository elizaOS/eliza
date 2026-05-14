// VisionServiceLifecycleManager
//
// Manages dynamic load/unload of vision sub-services (YOLO, RapidOCR,
// MediaPipe face, MoveNet pose, Florence2). Two ownership signals drive
// release:
//
//   1. **Idle watchdog** — if a sub-service hasn't been queried for
//      `idleUnloadMs` (default 60s), it's released.
//   2. **Memory-pressure listener** — when an external arbiter signals
//      pressure, the coldest sub-services are released first.
//
// The arbiter is owned by WS1 (`@elizaos/plugin-local-inference`). Until that
// service is registered on the runtime we operate in standalone mode: idle
// watchdog still ticks, but no external pressure signal arrives.
//
// Acquisition is opt-in: a sub-service that registers an `acquire` callback
// will be re-loaded on demand the next time it's used after a release.

import { logger } from "@elizaos/core";

/**
 * Minimal contract a memory arbiter must implement so vision can plug into
 * WS1's load/unload pipeline. Mirrors the (forthcoming) interface in
 * `@elizaos/plugin-local-inference/src/services/memory-arbiter.ts` but is
 * declared here so plugin-vision compiles standalone.
 */
export interface IModelArbiter {
  /**
   * Reserve `bytes` of model memory for `holder`. Returning `false` means the
   * arbiter refused — the caller must skip the load.
   */
  acquire(holder: string, bytes: number): Promise<boolean> | boolean;

  /**
   * Release the prior reservation for `holder`.
   */
  release(holder: string): Promise<void> | void;

  /**
   * Subscribe to memory-pressure events. The arbiter calls the listener with
   * a non-empty list of holders when pressure is high enough that those
   * holders should release.
   */
  onPressure(listener: (holders: string[]) => void): () => void;
}

export interface VisionSubServiceHandle {
  /** Stable holder id (e.g. "vision:yolo"). */
  id: string;
  /** Approximate VRAM/RAM cost in bytes. Used by the arbiter; ignored if 0. */
  memoryBytes: number;
  /** Optional hook invoked when the sub-service has been released. */
  unload(): Promise<void> | void;
  /** Optional hook invoked to re-load after a prior release. */
  acquire?(): Promise<void> | void;
}

export interface VisionLifecycleConfig {
  /** Milliseconds of inactivity before a sub-service is released. */
  idleUnloadMs?: number;
  /** Tick interval for the idle watchdog. */
  watchdogIntervalMs?: number;
}

interface RegisteredSub {
  handle: VisionSubServiceHandle;
  registeredAt: number;
  loaded: boolean;
  lastUsed: number;
}

const DEFAULT_IDLE_UNLOAD_MS = 60_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000;

export class VisionServiceLifecycleManager {
  private readonly subs = new Map<string, RegisteredSub>();
  private readonly idleUnloadMs: number;
  private readonly watchdogIntervalMs: number;
  private arbiter: IModelArbiter | null = null;
  private unsubscribePressure: (() => void) | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(config: VisionLifecycleConfig = {}) {
    this.idleUnloadMs = config.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
    this.watchdogIntervalMs =
      config.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  }

  attachArbiter(arbiter: IModelArbiter | null): void {
    if (this.arbiter === arbiter) return;
    if (this.unsubscribePressure) {
      this.unsubscribePressure();
      this.unsubscribePressure = null;
    }
    this.arbiter = arbiter;
    if (!arbiter) return;
    this.unsubscribePressure = arbiter.onPressure((holders) => {
      this.handlePressure(holders).catch((error) => {
        logger.error("[VisionLifecycle] pressure handler failed:", error);
      });
    });
  }

  register(handle: VisionSubServiceHandle): void {
    if (this.subs.has(handle.id)) return;
    this.subs.set(handle.id, {
      handle,
      registeredAt: Date.now(),
      loaded: true,
      lastUsed: Date.now(),
    });
    this.ensureWatchdog();
  }

  unregister(id: string): void {
    this.subs.delete(id);
  }

  /**
   * Mark a sub-service as in-use. If it was previously released, re-acquire
   * via the registered `acquire` callback (if any).
   *
   * Returns `true` if the sub-service is loaded after the call.
   */
  async touch(id: string): Promise<boolean> {
    const sub = this.subs.get(id);
    if (!sub) return false;
    sub.lastUsed = Date.now();
    if (sub.loaded) return true;
    if (!sub.handle.acquire) return false;
    if (this.arbiter) {
      const ok = await this.arbiter.acquire(
        sub.handle.id,
        sub.handle.memoryBytes,
      );
      if (!ok) {
        logger.warn(
          `[VisionLifecycle] arbiter refused acquisition of ${sub.handle.id}`,
        );
        return false;
      }
    }
    try {
      await sub.handle.acquire();
      sub.loaded = true;
      return true;
    } catch (error) {
      logger.error(
        `[VisionLifecycle] re-acquire failed for ${sub.handle.id}:`,
        error,
      );
      if (this.arbiter) await this.arbiter.release(sub.handle.id);
      return false;
    }
  }

  /**
   * Force-release a single holder.
   */
  async release(id: string): Promise<void> {
    const sub = this.subs.get(id);
    if (!sub || !sub.loaded) return;
    try {
      await sub.handle.unload();
    } catch (error) {
      logger.error(`[VisionLifecycle] unload failed for ${id}:`, error);
    }
    sub.loaded = false;
    if (this.arbiter) await this.arbiter.release(id);
  }

  /**
   * Drop every registered sub-service (used during plugin stop()).
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.unsubscribePressure) {
      this.unsubscribePressure();
      this.unsubscribePressure = null;
    }
    const ids = Array.from(this.subs.keys());
    for (const id of ids) {
      await this.release(id);
    }
    this.subs.clear();
  }

  /** Test-only: return current snapshot. */
  snapshot(): Array<{ id: string; loaded: boolean; lastUsed: number }> {
    return Array.from(this.subs.values()).map((s) => ({
      id: s.handle.id,
      loaded: s.loaded,
      lastUsed: s.lastUsed,
    }));
  }

  private ensureWatchdog(): void {
    if (this.watchdogTimer || this.stopped) return;
    this.watchdogTimer = setInterval(() => {
      this.runWatchdog().catch((error) => {
        logger.error("[VisionLifecycle] watchdog failed:", error);
      });
    }, this.watchdogIntervalMs);
    // Don't keep the event loop alive on the watchdog alone.
    this.watchdogTimer.unref?.();
  }

  private async runWatchdog(): Promise<void> {
    const cutoff = Date.now() - this.idleUnloadMs;
    for (const [id, sub] of this.subs) {
      if (!sub.loaded) continue;
      if (sub.lastUsed > cutoff) continue;
      logger.info(
        `[VisionLifecycle] idle release: ${id} (last used ${Date.now() - sub.lastUsed}ms ago)`,
      );
      await this.release(id);
    }
  }

  private async handlePressure(holders: string[]): Promise<void> {
    // Sort our visible holders by lastUsed asc (coldest first), then release
    // the ones the arbiter named (or all if names not listed).
    const named = new Set(holders);
    const candidates = Array.from(this.subs.values())
      .filter((s) => s.loaded && (named.size === 0 || named.has(s.handle.id)))
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const sub of candidates) {
      logger.info(`[VisionLifecycle] pressure release: ${sub.handle.id}`);
      await this.release(sub.handle.id);
    }
  }
}

/**
 * Try to resolve a model arbiter from the runtime, dynamically. This avoids
 * a hard dependency on `@elizaos/plugin-local-inference` (WS1) — vision still
 * works standalone when WS1 isn't installed.
 */
export function resolveArbiterFromRuntime(runtime: {
  getService?: (name: string) => unknown;
}): IModelArbiter | null {
  const candidates = ["MEMORY_ARBITER", "memory_arbiter", "memoryArbiter"];
  for (const name of candidates) {
    const svc = runtime.getService?.(name) as
      | Partial<IModelArbiter>
      | null
      | undefined;
    if (
      svc &&
      typeof svc.acquire === "function" &&
      typeof svc.release === "function" &&
      typeof svc.onPressure === "function"
    ) {
      return svc as IModelArbiter;
    }
  }
  return null;
}
