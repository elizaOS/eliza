interface RailGestureStore {
  active: boolean;
  /** performance.now()/Date.now() timestamp of the activating edge, so parked
   *  consumers can bound staleness if a release edge is ever missed. */
  since: number;
  listeners: Set<() => void>;
}

function store(): RailGestureStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.rail-gesture-store");
  const existing = g[k] as RailGestureStore | undefined;
  if (existing) return existing;
  const created: RailGestureStore = {
    active: false,
    since: 0,
    listeners: new Set(),
  };
  g[k] = created;
  return created;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function commit(s: RailGestureStore, active: boolean): void {
  if (s.active === active) return;
  s.active = active;
  s.since = active ? now() : 0;
  for (const l of s.listeners) l();
}

// ── Imperative actions (called from the pager's gesture handlers) ────────────

/** The rail entered its gesture/settle window. Idempotent. */
export function beginRailGesture(): void {
  commit(store(), true);
}

/** The rail's gesture window closed (settle ended / axis went vertical /
 *  surface unmounted). Idempotent. */
export function endRailGesture(): void {
  commit(store(), false);
}

/** Read the signal imperatively (event handlers / non-React callers). */
export function isRailGestureActive(): boolean {
  return store().active;
}

/** Milliseconds the current gesture window has been open; 0 when inactive. */
export function railGestureActiveMs(): number {
  const s = store();
  return s.active ? now() - s.since : 0;
}

/** Subscribe to activate/release edges. Returns the unsubscribe. */
export function subscribeRailGesture(listener: () => void): () => void {
  const s = store();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/** Reset to defaults. Test-only. */
export function resetRailGestureForTests(): void {
  const s = store();
  s.active = false;
  s.since = 0;
  for (const l of s.listeners) l();
}
