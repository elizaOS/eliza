export const MODULE_CACHE_TELEMETRY_EVENT = "eliza:module-cache-telemetry";

export type ModuleCacheTelemetrySource = "dynamic-view" | "retained-lazy";

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
    | "visibility-hidden"
    | "app-pause"
    | "invalidate";
  key?: string;
  activeCount: number;
  idleCount: number;
  cacheSize: number;
  at: number;
  route?: string;
}

let moduleCacheTelemetrySequence = 0;

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname;
}

export function emitModuleCacheTelemetry(
  event: Omit<ModuleCacheTelemetryEvent, "at" | "route">,
): void {
  const detail: ModuleCacheTelemetryEvent = {
    ...event,
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
