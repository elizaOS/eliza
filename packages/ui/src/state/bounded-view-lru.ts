/**
 * Shared device-memory sizing + LRU helpers for every bounded view cache in the
 * shell.
 *
 * Both `retained-lazy.tsx` (route-chunk module cache) and
 * `components/views/DynamicViewLoader.tsx` (remote-bundle module cache)
 * previously each carried their OWN copy of the `navigator.deviceMemory` tier
 * resolution and the default/low-memory cap+TTL constants. The new
 * keep-alive view-instance cache (`KeepAliveViewHost` via `ViewLifecycleController`)
 * needs the same tiering, so this module is the single home for it. The two
 * module caches import the sizing from here so all three bounded caches scale
 * off one device-memory read and one place to tune the thresholds.
 *
 * Pure + dependency-free (no React, no DOM beyond a defensive `navigator`
 * read), so it unit-tests trivially and stays importable from Node test envs.
 */

/** A device is "low memory" at or below this many GB of reported RAM. */
export const LOW_MEMORY_DEVICE_GB = 4;

// Module-cache tiers (extracted verbatim from retained-lazy.tsx so its behavior
// and existing test are unchanged).
export const DEFAULT_RETAINED_MODULE_TTL_MS = 5 * 60_000;
export const LOW_MEMORY_RETAINED_MODULE_TTL_MS = 60_000;
export const DEFAULT_RETAINED_MODULE_MAX_ENTRIES = 8;
export const LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES = 3;

// Keep-alive view-INSTANCE tiers. A retained view instance is far heavier than a
// retained module chunk (live React subtree, DOM, listeners), so the caps are
// deliberately smaller than the module caps: at most 3 retained instances on a
// normal device, 1 on a low-memory device. TTL mirrors the module idle windows.
export const DEFAULT_KEEP_ALIVE_MAX_VIEWS = 3;
export const LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS = 1;
export const DEFAULT_KEEP_ALIVE_TTL_MS = 5 * 60_000;
export const LOW_MEMORY_KEEP_ALIVE_TTL_MS = 60_000;

// Remote-bundle module-cache tiers (centralized here, previously hardcoded in
// DynamicViewLoader.tsx where they had silently diverged from the retained-lazy
// caps). A remote view bundle is heavier than a route chunk, so the normal cap
// is smaller than the retained-module cap but the low-memory floor matches.
export const DEFAULT_BUNDLE_MODULE_TTL_MS = 5 * 60_000;
export const LOW_MEMORY_BUNDLE_MODULE_TTL_MS = 60_000;
export const DEFAULT_BUNDLE_MODULE_MAX_ENTRIES = 6;
export const LOW_MEMORY_BUNDLE_MODULE_MAX_ENTRIES = 2;

/**
 * Live-heap pressure threshold: when `usedJSHeapSize / jsHeapSizeLimit` reaches
 * this fraction, every bounded cache drops to its low-memory tier and a forced
 * idle-eviction pass is requested (via {@link HEAP_PRESSURE_EVENT}). 0.8 leaves
 * headroom before the engine's own GC/OOM kicks in.
 */
export const HEAP_PRESSURE_RATIO = 0.8;

/**
 * Document event dispatched when live heap crosses {@link HEAP_PRESSURE_RATIO}.
 * This is the REAL memory-pressure signal for the caches: the non-standard
 * `memorypressure` window event Chromium never fires, so before this the caches
 * had no live-heap input at all. The heap-pressure-monitor polls
 * `performance.memory` while the tab is visible and dispatches this when usage
 * crosses {@link HEAP_PRESSURE_RATIO}; the module caches listen for it and
 * force-evict idle entries.
 */
export const HEAP_PRESSURE_EVENT = "eliza:heap-pressure";

/**
 * Reported device RAM in GB, or `null` when the (Chromium-only) hint is absent.
 * `null` is treated as "not low memory" by {@link isLowMemoryDevice} so engines
 * without the hint (Safari/Firefox) keep the larger caps rather than the
 * conservative ones.
 */
export function resolveDeviceMemoryGb(): number | null {
  if (typeof navigator === "undefined") return null;
  const value = (navigator as { deviceMemory?: unknown }).deviceMemory;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True only when the device reports RAM at or below {@link LOW_MEMORY_DEVICE_GB}. */
export function isLowMemoryDevice(): boolean {
  const memoryGb = resolveDeviceMemoryGb();
  return memoryGb !== null && memoryGb <= LOW_MEMORY_DEVICE_GB;
}

/** Live JS-heap reading from the (Chromium-only) `performance.memory` API. */
export interface JsHeapReading {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * Live heap usage from `performance.memory`, or `null` when the (Chromium-only)
 * API is absent (Safari/Firefox) or reports non-finite values. Shared by the
 * cache prune path, the cache-telemetry emitter, and {@link ViewTelemetryProfiler}
 * so there is exactly one heap read implementation in the shell.
 */
export function readJsHeap(): JsHeapReading | null {
  if (typeof performance === "undefined") return null;
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown };
    }
  ).memory;
  if (!memory) return null;
  const used = memory.usedJSHeapSize;
  const limit = memory.jsHeapSizeLimit;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return null;
  }
  return { usedJSHeapSize: used, jsHeapSizeLimit: limit };
}

/** Just the live used-heap bytes (or `undefined`), for telemetry payloads. */
export function readJsHeapUsedSize(): number | undefined {
  return readJsHeap()?.usedJSHeapSize;
}

/**
 * True when live heap usage is at or above {@link HEAP_PRESSURE_RATIO} of the
 * engine limit. Returns `false` (not "constrained") when the heap API is absent,
 * so non-Chromium engines keep the larger caps and rely on TTL/visibility/pause.
 */
export function isHeapUnderPressure(
  reading: JsHeapReading | null = readJsHeap(),
): boolean {
  if (!reading) return false;
  return (
    reading.usedJSHeapSize / reading.jsHeapSizeLimit >= HEAP_PRESSURE_RATIO
  );
}

/**
 * Single predicate the bounded caches size off: a device is treated as
 * memory-constrained when it is a static low-memory device OR live heap is
 * under pressure right now. This is the seam that finally feeds `usedJSHeapSize`
 * into the prune decision — every cap/TTL getter below routes through it.
 */
export function isCacheMemoryConstrained(): boolean {
  return isLowMemoryDevice() || isHeapUnderPressure();
}

export function getRetainedModuleTtlMs(): number {
  return isCacheMemoryConstrained()
    ? LOW_MEMORY_RETAINED_MODULE_TTL_MS
    : DEFAULT_RETAINED_MODULE_TTL_MS;
}

export function getRetainedModuleMaxEntries(): number {
  return isCacheMemoryConstrained()
    ? LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES
    : DEFAULT_RETAINED_MODULE_MAX_ENTRIES;
}

export function getBundleModuleTtlMs(): number {
  return isCacheMemoryConstrained()
    ? LOW_MEMORY_BUNDLE_MODULE_TTL_MS
    : DEFAULT_BUNDLE_MODULE_TTL_MS;
}

export function getBundleModuleMaxEntries(): number {
  return isCacheMemoryConstrained()
    ? LOW_MEMORY_BUNDLE_MODULE_MAX_ENTRIES
    : DEFAULT_BUNDLE_MODULE_MAX_ENTRIES;
}

/**
 * Max simultaneously-retained keep-alive view instances (the active view does
 * not count against this — it is always rendered). The host evicts the
 * least-recently-active retained view beyond this cap.
 */
export function getKeepAliveMaxViews(): number {
  return isCacheMemoryConstrained()
    ? LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS
    : DEFAULT_KEEP_ALIVE_MAX_VIEWS;
}

/** Idle TTL after which a retained-but-hidden keep-alive view is evicted. */
export function getKeepAliveTtlMs(): number {
  return isCacheMemoryConstrained()
    ? LOW_MEMORY_KEEP_ALIVE_TTL_MS
    : DEFAULT_KEEP_ALIVE_TTL_MS;
}

/**
 * Pure LRU eviction selection: given the ids currently retained and a map of
 * `id -> lastActiveAt`, return the ids that must be evicted to bring the
 * retained set down to `max`, **excluding** any `exempt` id (the active view +
 * pinned views). Oldest `lastActiveAt` is evicted first; ties broken by id for
 * determinism. Returns an empty array when already within the cap.
 *
 * Centralizing the selection here keeps the host (`KeepAliveViewHost`) and the
 * controller (`ViewLifecycleController`) honest: both call this one function so
 * the cap math can never drift between them.
 */
export function selectLruEvictions(
  retainedIds: readonly string[],
  lastActiveAt: ReadonlyMap<string, number>,
  max: number,
  exempt: ReadonlySet<string>,
): string[] {
  const eligible = retainedIds.filter((id) => !exempt.has(id));
  // `max` bounds the EVICTABLE (non-exempt) retained views — the active view and
  // pinned views do not count against the cap (see getKeepAliveMaxViews's
  // docstring). Evict eligible-oldest until the eligible count is within `max`.
  const overflow = eligible.length - max;
  if (overflow <= 0) return [];
  const ordered = [...eligible].sort((a, b) => {
    const at = lastActiveAt.get(a) ?? 0;
    const bt = lastActiveAt.get(b) ?? 0;
    if (at !== bt) return at - bt;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return ordered.slice(0, Math.min(overflow, ordered.length));
}
