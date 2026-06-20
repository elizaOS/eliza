import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  emitModuleCacheTelemetry,
  type ModuleCacheTelemetryEvent,
} from "./cache-telemetry";
import { APP_PAUSE_EVENT } from "./events";

type RetainedCleanup = () => void | Promise<void>;
type EvictReason = NonNullable<ModuleCacheTelemetryEvent["reason"]>;

export interface RetainedLazyModule<TProps extends object> {
  default: ComponentType<TProps>;
  cleanup?: RetainedCleanup;
}

export type RetainedLazyLoader<TProps extends object> = () => Promise<
  RetainedLazyModule<TProps>
>;

interface RetainedModuleEntry<TProps extends object> {
  loader: RetainedLazyLoader<TProps>;
  promise: Promise<RetainedLazyModule<TProps>>;
  module: RetainedLazyModule<TProps> | null;
  refCount: number;
  lastUsedAt: number;
  cleanupScheduled: boolean;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_RETAINED_MODULE_TTL_MS = 5 * 60_000;
const LOW_MEMORY_RETAINED_MODULE_TTL_MS = 60_000;
const DEFAULT_RETAINED_MODULE_MAX_ENTRIES = 8;
const LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES = 3;

const retainedModuleCache = new Map<
  RetainedLazyLoader<object>,
  RetainedModuleEntry<object>
>();

let retainedModuleLifecycleInstalled = false;
let pruneOnPressure: (() => void) | null = null;
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

function resolveDeviceMemoryGb(): number | null {
  if (typeof navigator === "undefined") return null;
  const value = (navigator as { deviceMemory?: unknown }).deviceMemory;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getRetainedModuleTtlMs(): number {
  const memoryGb = resolveDeviceMemoryGb();
  return memoryGb !== null && memoryGb <= 4
    ? LOW_MEMORY_RETAINED_MODULE_TTL_MS
    : DEFAULT_RETAINED_MODULE_TTL_MS;
}

function getRetainedModuleMaxEntries(): number {
  const memoryGb = resolveDeviceMemoryGb();
  return memoryGb !== null && memoryGb <= 4
    ? LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES
    : DEFAULT_RETAINED_MODULE_MAX_ENTRIES;
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
  emitRetainedTelemetry("evict", { reason });
  runCleanup(cleanup);
  if (cleanup) emitRetainedTelemetry("cleanup", { reason });
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
  const now = Date.now();
  const ttlMs = options.force ? 0 : getRetainedModuleTtlMs();
  const reason = options.reason ?? (options.force ? "memorypressure" : "ttl");
  const idleEntries = [...retainedModuleCache.values()]
    .filter((entry) => entry.refCount === 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  for (const entry of idleEntries) {
    if (options.force || now - entry.lastUsedAt >= ttlMs) {
      cleanupEntry(entry, reason);
    }
  }

  const maxEntries = options.force ? 0 : getRetainedModuleMaxEntries();
  let retained = [...retainedModuleCache.values()].filter(
    (entry) => entry.refCount === 0,
  );
  retained = retained.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (retainedModuleCache.size > maxEntries && retained.length > 0) {
    const entry = retained.shift();
    if (!entry) break;
    cleanupEntry(entry, options.reason ?? "lru");
  }
}

function installRetainedModuleLifecycle(): void {
  if (retainedModuleLifecycleInstalled || typeof window === "undefined") {
    return;
  }
  retainedModuleLifecycleInstalled = true;
  pruneOnPressure = () => {
    scheduleIdleWork(() =>
      pruneRetainedLazyModules({ force: true, reason: "memorypressure" }),
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
  document.addEventListener("visibilitychange", pruneOnVisibilityHidden);
  document.addEventListener(APP_PAUSE_EVENT, pruneOnAppPause);
}

function ensureEntry<TProps extends object>(
  loader: RetainedLazyLoader<TProps>,
): RetainedModuleEntry<TProps> {
  const existing = retainedModuleCache.get(
    loader as RetainedLazyLoader<object>,
  ) as RetainedModuleEntry<TProps> | undefined;
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  let entry: RetainedModuleEntry<TProps>;
  const promise = loader().then(
    (module) => {
      entry.module = module;
      entry.lastUsedAt = Date.now();
      emitRetainedTelemetry("load");
      if (
        entry.cleanupScheduled ||
        (retainedModuleCache.get(loader as RetainedLazyLoader<object>) !==
          (entry as RetainedModuleEntry<object>) &&
          entry.refCount === 0)
      ) {
        const cleanup = entry.module.cleanup;
        entry.module = null;
        runCleanup(cleanup);
        if (cleanup) emitRetainedTelemetry("cleanup");
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
      emitRetainedTelemetry("load-error");
      throw error;
    },
  );

  entry = {
    loader,
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
): {
  promise: Promise<RetainedLazyModule<TProps>>;
  release: () => void;
} {
  installRetainedModuleLifecycle();
  const entry = ensureEntry(loader);
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
      emitRetainedTelemetry("release");
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
): Promise<RetainedLazyModule<TProps>> {
  installRetainedModuleLifecycle();
  return ensureEntry(loader).promise;
}

export function __resetRetainedLazyModulesForTests(): void {
  for (const entry of retainedModuleCache.values()) {
    if (entry.retentionTimer) clearTimeout(entry.retentionTimer);
  }
  retainedModuleCache.clear();
  if (typeof window !== "undefined" && pruneOnPressure) {
    window.removeEventListener("memorypressure", pruneOnPressure);
  }
  if (typeof document !== "undefined" && pruneOnVisibilityHidden) {
    document.removeEventListener("visibilitychange", pruneOnVisibilityHidden);
  }
  if (typeof document !== "undefined" && pruneOnAppPause) {
    document.removeEventListener(APP_PAUSE_EVENT, pruneOnAppPause);
  }
  pruneOnPressure = null;
  pruneOnVisibilityHidden = null;
  pruneOnAppPause = null;
  retainedModuleLifecycleInstalled = false;
}

export function RetainedLazyComponent<TProps extends object>({
  loader,
  componentProps,
  fallback = null,
  onError,
}: {
  loader: RetainedLazyLoader<TProps>;
  componentProps: TProps;
  fallback?: ReactNode;
  onError?: (error: Error) => ReactNode;
}) {
  const [module, setModule] = useState<RetainedLazyModule<TProps> | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lease = acquireRetainedLazyModule(loader);
    setModule(null);
    setError(null);
    void lease.promise
      .then((nextModule) => {
        if (!cancelled) setModule(nextModule);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [loader]);

  const renderedError = useMemo(
    () => (error && onError ? onError(error) : null),
    [error, onError],
  );
  if (error) return renderedError;
  if (!module) return <>{fallback}</>;
  const Component = module.default;
  return <Component {...componentProps} />;
}
