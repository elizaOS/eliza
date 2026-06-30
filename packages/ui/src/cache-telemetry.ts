import { readJsHeapUsedSize } from "./state/bounded-view-lru";

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
  /**
   * Live `performance.memory.usedJSHeapSize` (bytes) at emit time, or omitted
   * when the Chromium-only heap API is unavailable. Lets the views soak assert
   * heap growth/eviction directly off the module-cache ring (#10196).
   */
  jsHeapUsedSize?: number;
  at: number;
  route?: string;
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
  const jsHeapUsedSize = readJsHeapUsedSize();
  const detail: ModuleCacheTelemetryEvent = {
    ...event,
    ...(jsHeapUsedSize !== undefined ? { jsHeapUsedSize } : {}),
    at: Date.now(),
    route: currentRoute(),
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
