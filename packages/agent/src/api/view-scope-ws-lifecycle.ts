/**
 * Defers per-client view-scope cleanup across transient WebSocket disconnects.
 * The server owns socket liveness; this module owns the bounded timer and
 * rechecks liveness when it fires so reconnects preserve the active view.
 */

/** Grace period before an unconnected client's scoped view state is cleared. */
export const DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS = 30_000;

export interface ScheduleViewScopeClearOptions {
  clientId: string;
  pendingClears: Map<string, ReturnType<typeof setTimeout>>;
  clientHasLiveConnection: () => boolean;
  clearViewScope: (clientId: string) => void;
  shouldSchedule?: () => boolean;
  graceMs?: number;
}

export interface RegisterViewScopeConnectionOptions {
  clientId: string;
  pendingClears: Map<string, ReturnType<typeof setTimeout>>;
  markViewScopeConnected: (clientId: string) => void;
}

/**
 * Register an authenticated socket and cancel any cleanup left by the socket
 * it replaces. The authoritative state module uses the registration to keep
 * live WebSocket scopes out of its REST-only inactivity reap.
 */
export function registerViewScopeConnection({
  clientId,
  pendingClears,
  markViewScopeConnected,
}: RegisterViewScopeConnectionOptions): boolean {
  const reconnected = cancelPendingViewScopeClear(clientId, pendingClears);
  markViewScopeConnected(clientId);
  return reconnected;
}

/**
 * Schedule cleanup for one client scope after the reconnect grace period.
 * Re-scheduling replaces the previous timer, while a live sibling connection
 * prevents cleanup both at schedule time and when the timer fires.
 */
export function scheduleViewScopeClearAfterGrace({
  clientId,
  pendingClears,
  clientHasLiveConnection,
  clearViewScope,
  shouldSchedule = () => true,
  graceMs = DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS,
}: ScheduleViewScopeClearOptions): void {
  if (!shouldSchedule()) return;
  if (clientHasLiveConnection()) return;

  const existing = pendingClears.get(clientId);
  if (existing !== undefined) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingClears.delete(clientId);
    if (!shouldSchedule()) return;
    if (clientHasLiveConnection()) return;
    clearViewScope(clientId);
  }, graceMs);
  timer.unref?.();
  pendingClears.set(clientId, timer);
}

/** Cancel a pending scope cleanup when the same client reconnects. */
export function cancelPendingViewScopeClear(
  clientId: string,
  pendingClears: Map<string, ReturnType<typeof setTimeout>>,
): boolean {
  const timer = pendingClears.get(clientId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  pendingClears.delete(clientId);
  return true;
}
