/**
 * Shared device-memory sizing + LRU helpers for every bounded view cache in the
 * shell.
 *
 * Single home for the `navigator.deviceMemory` tier resolution and the
 * default/low-memory cap+TTL constants shared by all three bounded caches:
 * `retained-lazy.tsx` (route-chunk module cache),
 * `components/views/DynamicViewLoader.tsx` (remote-bundle module cache), and
 * the keep-alive view-instance cache (`KeepAliveViewHost` via
 * `ViewLifecycleController`). They import the sizing from here so all three
 * scale off one device-memory read and one place to tune the thresholds.
 *
 * Pure + dependency-free (no React, no DOM beyond a defensive `navigator`
 * read), so it unit-tests trivially and stays importable from Node test envs.
 */

/** A device is "low memory" at or below this many GB of reported RAM. */
export const LOW_MEMORY_DEVICE_GB = 4;

/**
 * Live JS-heap fill ratio at or above which the caches treat the runtime as
 * memory-pressured, regardless of the static device-RAM hint (#10196). 0.8 = the
 * heap is within 20% of its hard limit, where the next large allocation risks an
 * OOM / GC stall, so the bounded caches should be at their conservative tier.
 */
export const HEAP_PRESSURE_RATIO = 0.8;

/**
 * Document event the shared heap-pressure monitor dispatches when live
 * `usedJSHeapSize` crosses {@link HEAP_PRESSURE_RATIO} (#10196). The bounded
 * caches (`DynamicViewLoader`, `retained-lazy`) listen for it and force-evict
 * idle entries — the real heap-driven trigger, as opposed to the non-standard
 * `memorypressure` window event Chromium never fires. See heap-pressure-monitor.
 */
export const HEAP_PRESSURE_EVENT = "eliza:heap-pressure";

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

/** Live JS heap usage from the (Chromium-only) `performance.memory`, or `null`. */
export interface HeapUsage {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function resolveHeapUsage(): HeapUsage | null {
  if (typeof performance === "undefined") return null;
  const memory = (
    performance as {
      memory?: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown };
    }
  ).memory;
  if (!memory) return null;
  const used = memory.usedJSHeapSize;
  const limit = memory.jsHeapSizeLimit;
  if (
    typeof used === "number" &&
    Number.isFinite(used) &&
    used >= 0 &&
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    limit > 0
  ) {
    return { usedJSHeapSize: used, jsHeapSizeLimit: limit };
  }
  return null;
}

/** Live heap fill ratio in `[0, ∞)`, or `null` when the hint is absent. */
export function getHeapPressureRatio(): number | null {
  const heap = resolveHeapUsage();
  return heap ? heap.usedJSHeapSize / heap.jsHeapSizeLimit : null;
}

/** True when the live JS heap sits at/above {@link HEAP_PRESSURE_RATIO} of its limit. */
export function isHeapUnderPressure(): boolean {
  const ratio = getHeapPressureRatio();
  return ratio !== null && ratio >= HEAP_PRESSURE_RATIO;
}

/**
 * The bounded view caches shrink under EITHER a static low-memory device hint OR
 * live JS-heap pressure (#10196). Previously only the static `deviceMemory` hint
 * tiered the caps, so a roomy device whose heap was climbing toward its limit
 * right now kept the larger caps until an OS `memorypressure`/visibility event
 * fired. Now a near-limit live heap tightens the caps proactively. Engines
 * without `performance.memory` (Safari/Firefox) fall back to the device hint
 * alone, exactly as before.
 */
export function isUnderMemoryPressure(): boolean {
  return isLowMemoryDevice() || isHeapUnderPressure();
}

export function getRetainedModuleTtlMs(): number {
  return isUnderMemoryPressure()
    ? LOW_MEMORY_RETAINED_MODULE_TTL_MS
    : DEFAULT_RETAINED_MODULE_TTL_MS;
}

export function getRetainedModuleMaxEntries(): number {
  return isUnderMemoryPressure()
    ? LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES
    : DEFAULT_RETAINED_MODULE_MAX_ENTRIES;
}

/**
 * Max simultaneously-retained keep-alive view instances (the active view does
 * not count against this — it is always rendered). The host evicts the
 * least-recently-active retained view beyond this cap.
 */
export function getKeepAliveMaxViews(): number {
  return isUnderMemoryPressure()
    ? LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS
    : DEFAULT_KEEP_ALIVE_MAX_VIEWS;
}

/** Idle TTL after which a retained-but-hidden keep-alive view is evicted. */
export function getKeepAliveTtlMs(): number {
  return isUnderMemoryPressure()
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

/** Minimal shape of a bounded module-cache entry the eviction planner reads. */
export interface ModuleCacheEntryLike {
  /** >0 while at least one mounted view holds the module; such entries are pinned. */
  refCount: number;
  /** `Date.now()` of the last acquire/release; the LRU + TTL ordering key. */
  lastUsedAt: number;
}

/** Which phase of the prune selected an entry — drives the telemetry reason. */
export type ModuleCacheEvictionPhase = "ttl" | "lru";

export interface ModuleCacheEvictionPlanOptions {
  /** Wall-clock reference (`Date.now()`); injected so the planner stays pure. */
  now: number;
  /** Idle TTL in ms; an idle entry past this is TTL-evicted. `0` evicts all idle. */
  ttlMs: number;
  /** Cap on total retained entries after the TTL sweep; overflow is LRU-evicted. */
  maxEntries: number;
  /** Force-evict every idle entry regardless of TTL (memory-pressure / app-pause). */
  force: boolean;
  /** Current `cache.size` (active + idle) the cap is measured against. */
  totalSize: number;
}

/**
 * Pure eviction planner shared by the two bounded module caches
 * (`retained-lazy.tsx`, `components/views/DynamicViewLoader.tsx`), which
 * previously each carried a byte-identical copy of this TTL-sweep + LRU-cap loop
 * (#10196 — "the eviction policy is not centralized or independently testable").
 *
 * It reproduces that loop exactly: first every idle (`refCount === 0`) entry
 * older than `ttlMs` (all of them when `force`) is selected oldest-first as a
 * `"ttl"` eviction; then, if the cache would still exceed `maxEntries` after
 * those, additional idle entries are selected oldest-first as `"lru"` evictions
 * until the total is within the cap. Active (`refCount > 0`) entries are never
 * selected. The caller maps each phase to its telemetry reason and runs its own
 * `cleanup`, so behavior — including emit order — is unchanged.
 */
export function planModuleCacheEvictions<E extends ModuleCacheEntryLike>(
  entries: readonly E[],
  options: ModuleCacheEvictionPlanOptions,
): { entry: E; phase: ModuleCacheEvictionPhase }[] {
  const { now, ttlMs, maxEntries, force, totalSize } = options;
  const idleOldestFirst = entries
    .filter((entry) => entry.refCount === 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  const plan: { entry: E; phase: ModuleCacheEvictionPhase }[] = [];
  const ttlEvicted = new Set<E>();
  for (const entry of idleOldestFirst) {
    if (force || now - entry.lastUsedAt >= ttlMs) {
      plan.push({ entry, phase: "ttl" });
      ttlEvicted.add(entry);
    }
  }

  // The original LRU phase re-reads `cache.size` AFTER the TTL deletes, then
  // evicts the oldest still-idle entries until within the cap. Mirror that by
  // shrinking the measured size by the TTL evictions and skipping them here.
  let retainedSize = totalSize - ttlEvicted.size;
  for (const entry of idleOldestFirst) {
    if (retainedSize <= maxEntries) break;
    if (ttlEvicted.has(entry)) continue;
    plan.push({ entry, phase: "lru" });
    retainedSize -= 1;
  }
  return plan;
}
