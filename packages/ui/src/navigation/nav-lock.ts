/**
 * Navigation lock for guided flows (the interactive tour). While a lock is set,
 * the app may only navigate to the tabs the current step allows — so a stray
 * control, a deep link, the chat's own nav buttons, or an agent action can't
 * drift the app into a state the guided flow doesn't expect. `setTab` consults
 * {@link isNavAllowed}; the tour sets the per-frame allow-set and clears it on
 * exit.
 *
 * Module-level singleton via globalThis so it survives HMR and is reachable from
 * both the navigation layer and the tour overlay without prop drilling.
 */

interface NavLockStore {
  allowed: ReadonlySet<string> | null;
}

function store(): NavLockStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.nav-lock");
  const existing = g[k] as NavLockStore | undefined;
  if (existing) return existing;
  const created: NavLockStore = { allowed: null };
  g[k] = created;
  return created;
}

/** Restrict navigation to `allowedTabs`; pass `null` to remove the lock. */
export function setNavLock(allowedTabs: readonly string[] | null): void {
  store().allowed = allowedTabs ? new Set(allowedTabs) : null;
}

/** Whether a navigation lock is currently in effect. */
export function isNavLocked(): boolean {
  return store().allowed !== null;
}

/** Whether navigating to `tab` is currently permitted. */
export function isNavAllowed(tab: string): boolean {
  const { allowed } = store();
  return allowed === null || allowed.has(tab);
}
