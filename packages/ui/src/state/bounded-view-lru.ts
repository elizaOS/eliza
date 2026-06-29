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

export function getRetainedModuleTtlMs(): number {
  return isLowMemoryDevice()
    ? LOW_MEMORY_RETAINED_MODULE_TTL_MS
    : DEFAULT_RETAINED_MODULE_TTL_MS;
}

export function getRetainedModuleMaxEntries(): number {
  return isLowMemoryDevice()
    ? LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES
    : DEFAULT_RETAINED_MODULE_MAX_ENTRIES;
}

/**
 * Max simultaneously-retained keep-alive view instances (the active view does
 * not count against this — it is always rendered). The host evicts the
 * least-recently-active retained view beyond this cap.
 */
export function getKeepAliveMaxViews(): number {
  return isLowMemoryDevice()
    ? LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS
    : DEFAULT_KEEP_ALIVE_MAX_VIEWS;
}

/** Idle TTL after which a retained-but-hidden keep-alive view is evicted. */
export function getKeepAliveTtlMs(): number {
  return isLowMemoryDevice()
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
