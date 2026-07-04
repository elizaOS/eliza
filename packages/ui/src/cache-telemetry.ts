/**
 * Module-cache telemetry: the event name and payload the retained-lazy loader
 * emits, plus heap-usage resolution, for the perf overlay.
 */
import { resolveHeapUsage } from "./state/bounded-view-lru";

export const MODULE_CACHE_TELEMETRY_EVENT = "eliza:module-cache-telemetry";

export type ModuleCacheTelemetrySource =
  | "dynamic-view"
  | "retained-lazy"
  | "view-lifecycle";

export type ModuleCacheTelemetryAction =
  | "load"
  | "load-error"
  | "release"
  | "evict"
  | "cleanup";

export interface ModuleCacheTelemetryEvent {
  source: ModuleCacheTelemetrySource;
  action: ModuleCacheTelemetryAction;
  reason?:
    | "ttl"
    | "lru"
    | "memorypressure"
    // Live `usedJSHeapSize` crossed HEAP_PRESSURE_RATIO (#10196) — the real
    // heap-driven eviction, as opposed to the never-fired `memorypressure`.
    | "heap-pressure"
    | "visibility-hidden"
    | "app-pause"
    | "invalidate"
    // View-lifecycle eviction reason: a default (non-keepAlive) view was
    // unmounted because another view became active (#10202).
    | "inactive";
  key?: string;
  activeCount: number;
  idleCount: number;
  cacheSize: number;
  at: number;
  route?: string;
  /**
   * Live JS heap at emit time (Chromium `performance.memory`); absent on engines
   * without the hint. Lets a `audit:views` soak read whether eviction tracked
   * real heap growth, not just the static device-RAM tier (#10196).
   */
  usedJSHeapSize?: number;
  jsHeapSizeLimit?: number;
  heapPressureRatio?: number;
}

/** Non-optional eviction reason carried on cache telemetry events. */
export type EvictReason = NonNullable<ModuleCacheTelemetryEvent["reason"]>;

let moduleCacheTelemetrySequence = 0;

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname;
}

export function emitModuleCacheTelemetry(
  event: Omit<ModuleCacheTelemetryEvent, "at" | "route">,
): void {
  const heap = resolveHeapUsage();
  const detail: ModuleCacheTelemetryEvent = {
    ...event,
    at: Date.now(),
    route: currentRoute(),
    ...(heap
      ? {
          usedJSHeapSize: heap.usedJSHeapSize,
          jsHeapSizeLimit: heap.jsHeapSizeLimit,
          heapPressureRatio: heap.usedJSHeapSize / heap.jsHeapSizeLimit,
        }
      : {}),
  };

  const globalObject = globalThis as typeof globalThis & {
    __ELIZA_MODULE_CACHE_TELEMETRY__?: ModuleCacheTelemetryEvent[];
    __ELIZA_MODULE_CACHE_TELEMETRY_SEQUENCE__?: number;
  };
  moduleCacheTelemetrySequence += 1;
  globalObject.__ELIZA_MODULE_CACHE_TELEMETRY_SEQUENCE__ =
    moduleCacheTelemetrySequence;
  if (Array.isArray(globalObject.__ELIZA_MODULE_CACHE_TELEMETRY__)) {
    globalObject.__ELIZA_MODULE_CACHE_TELEMETRY__.push(detail);
  }

  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(
      new CustomEvent(MODULE_CACHE_TELEMETRY_EVENT, { detail }),
    );
  }
}
