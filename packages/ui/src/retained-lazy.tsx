/**
 * Lazy component loader that retains resolved modules across mounts (with cache
 * telemetry), so heavy views don't re-import on every navigation.
 */
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type EvictReason,
  emitModuleCacheTelemetry,
  type ModuleCacheTelemetryEvent,
} from "./cache-telemetry";
import { APP_PAUSE_EVENT } from "./events";
import {
  getRetainedModuleMaxEntries,
  getRetainedModuleTtlMs,
  HEAP_PRESSURE_EVENT,
  planModuleCacheEvictions,
} from "./state/bounded-view-lru";
import { installHeapPressureMonitor } from "./state/heap-pressure-monitor";

type RetainedCleanup = () => void | Promise<void>;

/**
 * A resolved module is only mountable if its `default` export is a React
 * component — a function component/class, or an exotic component object
 * (`memo`/`forwardRef`/`lazy`, which carry a `$$typeof`). Anything else
 * (a missing/undefined export, a plain object, a string) would make React throw
 * "Element type is invalid" and paint a blank screen when rendered as
 * `<Component … />`, so we detect it up front and surface the error card.
 */
function isRenderableComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

export interface RetainedLazyModule<TProps extends object> {
  default: ComponentType<TProps>;
  cleanup?: RetainedCleanup;
}

export type RetainedLazyLoader<TProps extends object> = () => Promise<
  RetainedLazyModule<TProps>
>;

interface RetainedModuleEntry<TProps extends object> {
  loader: RetainedLazyLoader<TProps>;
  key?: string;
  promise: Promise<RetainedLazyModule<TProps>>;
  module: RetainedLazyModule<TProps> | null;
  refCount: number;
  lastUsedAt: number;
  cleanupScheduled: boolean;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

const retainedModuleCache = new Map<
  RetainedLazyLoader<object>,
  RetainedModuleEntry<object>
>();

let retainedModuleLifecycleInstalled = false;
let pruneOnPressure: (() => void) | null = null;
let pruneOnHeapPressure: (() => void) | null = null;
let pruneOnVisibilityHidden: (() => void) | null = null;
let pruneOnAppPause: (() => void) | null = null;

function retainedCacheStats(): {
  activeCount: number;
  idleCount: number;
  cacheSize: number;
} {
  let activeCount = 0;
  let idleCount = 0;
  for (const entry of retainedModuleCache.values()) {
    if (entry.refCount > 0) {
      activeCount += 1;
    } else {
      idleCount += 1;
    }
  }
  return { activeCount, idleCount, cacheSize: retainedModuleCache.size };
}

function emitRetainedTelemetry(
  action: ModuleCacheTelemetryEvent["action"],
  patch: {
    key?: string;
    reason?: EvictReason;
  } = {},
): void {
  emitModuleCacheTelemetry({
    source: "retained-lazy",
    action,
    ...patch,
    ...retainedCacheStats(),
  });
}

function scheduleIdleWork(work: () => void): void {
  if (typeof window === "undefined") {
    work();
    return;
  }
  const w = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      options?: { timeout?: number },
    ) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(work, { timeout: 2_000 });
    return;
  }
  window.setTimeout(work, 250);
}

function runCleanup(cleanup: RetainedCleanup | undefined): void {
  if (!cleanup) return;
  void Promise.resolve()
    .then(() => cleanup())
    .catch(() => {
      // Module cleanup is best-effort and must never crash the host shell.
    });
}

function cleanupEntry(
  entry: RetainedModuleEntry<object>,
  reason: EvictReason,
): void {
  if (entry.refCount > 0 || entry.cleanupScheduled) return;
  entry.cleanupScheduled = true;
  if (retainedModuleCache.get(entry.loader) === entry) {
    retainedModuleCache.delete(entry.loader);
  }
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  }
  const cleanup = entry.module?.cleanup;
  entry.module = null;
  emitRetainedTelemetry("evict", { key: entry.key, reason });
  runCleanup(cleanup);
  if (cleanup) emitRetainedTelemetry("cleanup", { key: entry.key, reason });
}

function armRetentionTimer(entry: RetainedModuleEntry<object>): void {
  if (typeof window === "undefined") return;
  if (entry.retentionTimer) clearTimeout(entry.retentionTimer);
  entry.retentionTimer = setTimeout(() => {
    entry.retentionTimer = null;
    scheduleIdleWork(() => pruneRetainedLazyModules());
  }, getRetainedModuleTtlMs() + 50);
}

export function pruneRetainedLazyModules(
  options: { force?: boolean; reason?: EvictReason } = {},
): void {
  const ttlReason =
    options.reason ?? (options.force ? "memorypressure" : "ttl");
  const lruReason = options.reason ?? "lru";
  const plan = planModuleCacheEvictions([...retainedModuleCache.values()], {
    now: Date.now(),
    ttlMs: options.force ? 0 : getRetainedModuleTtlMs(),
    maxEntries: options.force ? 0 : getRetainedModuleMaxEntries(),
    force: options.force ?? false,
    totalSize: retainedModuleCache.size,
  });
  for (const { entry, phase } of plan) {
    cleanupEntry(entry, phase === "ttl" ? ttlReason : lruReason);
  }
}

function installRetainedModuleLifecycle(): void {
  if (retainedModuleLifecycleInstalled || typeof window === "undefined") {
    return;
  }
  retainedModuleLifecycleInstalled = true;
  installHeapPressureMonitor();
  pruneOnPressure = () => {
    scheduleIdleWork(() =>
      pruneRetainedLazyModules({ force: true, reason: "memorypressure" }),
    );
  };
  // Real heap-driven eviction (#10196) — see DynamicViewLoader for rationale.
  pruneOnHeapPressure = () => {
    scheduleIdleWork(() =>
      pruneRetainedLazyModules({ force: true, reason: "heap-pressure" }),
    );
  };
  pruneOnVisibilityHidden = () => {
    if (document.visibilityState === "hidden") {
      scheduleIdleWork(() =>
        pruneRetainedLazyModules({ reason: "visibility-hidden" }),
      );
    }
  };
  pruneOnAppPause = () => {
    scheduleIdleWork(() =>
      pruneRetainedLazyModules({ force: true, reason: "app-pause" }),
    );
  };
  window.addEventListener("memorypressure", pruneOnPressure);
  document.addEventListener(HEAP_PRESSURE_EVENT, pruneOnHeapPressure);
  document.addEventListener("visibilitychange", pruneOnVisibilityHidden);
  document.addEventListener(APP_PAUSE_EVENT, pruneOnAppPause);
}

function ensureEntry<TProps extends object>(
  loader: RetainedLazyLoader<TProps>,
  options: { key?: string } = {},
): RetainedModuleEntry<TProps> {
  const existing = retainedModuleCache.get(
    loader as RetainedLazyLoader<object>,
  ) as RetainedModuleEntry<TProps> | undefined;
  if (existing) {
    existing.key = options.key ?? existing.key;
    existing.lastUsedAt = Date.now();
    return existing;
  }

  let entry: RetainedModuleEntry<TProps>;
  const promise = loader().then(
    (module) => {
      entry.module = module;
      entry.lastUsedAt = Date.now();
      emitRetainedTelemetry("load", { key: entry.key });
      if (
        entry.cleanupScheduled ||
        (retainedModuleCache.get(loader as RetainedLazyLoader<object>) !==
          (entry as RetainedModuleEntry<object>) &&
          entry.refCount === 0)
      ) {
        const cleanup = entry.module.cleanup;
        entry.module = null;
        runCleanup(cleanup);
        if (cleanup) emitRetainedTelemetry("cleanup", { key: entry.key });
        return module;
      }
      if (entry.refCount === 0) {
        armRetentionTimer(entry as RetainedModuleEntry<object>);
        scheduleIdleWork(() => pruneRetainedLazyModules());
      }
      return module;
    },
    (error) => {
      if (
        retainedModuleCache.get(loader as RetainedLazyLoader<object>) ===
        (entry as RetainedModuleEntry<object>)
      ) {
        retainedModuleCache.delete(loader as RetainedLazyLoader<object>);
      }
      emitRetainedTelemetry("load-error", { key: entry.key });
      throw error;
    },
  );

  entry = {
    loader,
    key: options.key,
    promise,
    module: null,
    refCount: 0,
    lastUsedAt: Date.now(),
    cleanupScheduled: false,
    retentionTimer: null,
  };
  retainedModuleCache.set(
    loader as RetainedLazyLoader<object>,
    entry as RetainedModuleEntry<object>,
  );
  return entry;
}

export function acquireRetainedLazyModule<TProps extends object>(
  loader: RetainedLazyLoader<TProps>,
  options: { cacheKey?: string } = {},
): {
  promise: Promise<RetainedLazyModule<TProps>>;
  release: () => void;
} {
  installRetainedModuleLifecycle();
  const entry = ensureEntry(loader, { key: options.cacheKey });
  entry.refCount += 1;
  entry.lastUsedAt = Date.now();
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  }

  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      emitRetainedTelemetry("release", { key: entry.key });
      if (entry.refCount !== 0) return;
      if (
        retainedModuleCache.get(loader as RetainedLazyLoader<object>) ===
        (entry as RetainedModuleEntry<object>)
      ) {
        armRetentionTimer(entry as RetainedModuleEntry<object>);
        scheduleIdleWork(() => pruneRetainedLazyModules());
      } else {
        cleanupEntry(entry as RetainedModuleEntry<object>, "invalidate");
      }
    },
  };
}

export function invalidateRetainedLazyModule<TProps extends object>(
  loader: RetainedLazyLoader<TProps>,
): void {
  const entry = retainedModuleCache.get(loader as RetainedLazyLoader<object>) as
    | RetainedModuleEntry<object>
    | undefined;
  if (!entry) return;
  retainedModuleCache.delete(loader as RetainedLazyLoader<object>);
  if (entry.refCount === 0) cleanupEntry(entry, "invalidate");
}

export function preloadRetainedLazyModule<TProps extends object>(
  loader: RetainedLazyLoader<TProps>,
  options: { cacheKey?: string } = {},
): Promise<RetainedLazyModule<TProps>> {
  installRetainedModuleLifecycle();
  return ensureEntry(loader, { key: options.cacheKey }).promise;
}

export function __resetRetainedLazyModulesForTests(): void {
  for (const entry of retainedModuleCache.values()) {
    if (entry.retentionTimer) clearTimeout(entry.retentionTimer);
  }
  retainedModuleCache.clear();
  if (typeof window !== "undefined" && pruneOnPressure) {
    window.removeEventListener("memorypressure", pruneOnPressure);
  }
  if (typeof document !== "undefined" && pruneOnHeapPressure) {
    document.removeEventListener(HEAP_PRESSURE_EVENT, pruneOnHeapPressure);
  }
  if (typeof document !== "undefined" && pruneOnVisibilityHidden) {
    document.removeEventListener("visibilitychange", pruneOnVisibilityHidden);
  }
  if (typeof document !== "undefined" && pruneOnAppPause) {
    document.removeEventListener(APP_PAUSE_EVENT, pruneOnAppPause);
  }
  pruneOnPressure = null;
  pruneOnHeapPressure = null;
  pruneOnVisibilityHidden = null;
  pruneOnAppPause = null;
  retainedModuleLifecycleInstalled = false;
}

export function RetainedLazyComponent<TProps extends object>({
  loader,
  cacheKey,
  componentProps,
  fallback = null,
  onError,
}: {
  loader: RetainedLazyLoader<TProps>;
  cacheKey?: string;
  componentProps: TProps;
  fallback?: ReactNode;
  /**
   * Recoverable failure surface. Receives the error and a `retry` that
   * re-imports the module (invalidating the failed cache entry). Callers should
   * render a card with a Retry affordance so a load/parse/missing-export failure
   * never leaves a blank screen. When omitted, `fallback` is shown instead of a
   * blank render.
   */
  onError?: (error: Error, retry: () => void) => ReactNode;
}) {
  const [module, setModule] = useState<RetainedLazyModule<TProps> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Bumping this re-runs the load effect after a Retry: the failed cache entry
  // is invalidated and the module re-imported, so a transient failure recovers
  // instead of latching a permanent error card.
  const [reloadKey, setReloadKey] = useState(0);

  // reloadKey is a manual re-import trigger (see `retry`), so it must be a dep.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-arms the import
  useEffect(() => {
    let cancelled = false;
    const lease = acquireRetainedLazyModule(loader, { cacheKey });
    setModule(null);
    setError(null);
    void lease.promise
      .then((nextModule) => {
        if (cancelled) return;
        // Import resolved but the module has no renderable default component:
        // mounting `<undefined … />` throws "Element type is invalid" and paints
        // blank. Surface the recoverable error instead of rendering nothing.
        if (!isRenderableComponent(nextModule?.default)) {
          setError(
            new Error("Loaded module did not export a default React component"),
          );
          return;
        }
        setModule(nextModule);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [loader, cacheKey, reloadKey]);

  const retry = useCallback(() => {
    invalidateRetainedLazyModule(loader);
    setError(null);
    setModule(null);
    setReloadKey((k) => k + 1);
  }, [loader]);

  const renderedError = useMemo(() => {
    if (!error) return null;
    // A caller with `onError` gets the recoverable card; otherwise fall back to
    // the loading placeholder rather than a blank render.
    return onError ? onError(error, retry) : fallback;
  }, [error, onError, retry, fallback]);
  if (error) return renderedError;
  if (!module) return <>{fallback}</>;
  const Component = module.default;
  return <Component {...componentProps} />;
}
