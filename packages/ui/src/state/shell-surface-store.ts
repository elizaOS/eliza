import * as React from "react";
import {
  HOME_LAUNCHER_NAV_EVENT,
  type HomeLauncherNavigationDetail,
  type HomeLauncherPage,
} from "../components/shell/home-launcher-events";

/**
 * Shell-surface store — the SINGLE source of truth for the home/launcher
 * launcher's navigation state.
 *
 * Before this store there were four uncoordinated navigation state machines
 * (the route `tab`, HomeLauncherSurface's local `page`, the Launcher's
 * local `page` + `editing`, and the chat overlay's `mode`). Because no single
 * thing owned "which launcher screen am I on", a horizontal swipe was claimed by
 * two machines, two page-indicators rendered at once, and the launcher's
 * `editing` flag survived navigation — leaving the user stranded in jiggle mode
 * with no way back. This store collapses the launcher's navigation (machines 2
 * and 3) into one model that every surface DERIVES from.
 *
 * The non-negotiable invariant lives here, not in a component: leaving the
 * launcher (page !== "launcher") ALWAYS resets the transient sub-state
 * (`launcherPage` → 0), so re-entering never lands on a stale inner page. The
 * launcher itself is read-only (no edit/jiggle mode), so there is no editing
 * sub-state to reset.
 *
 * Module-level store shared via globalThis (survives HMR + reachable from the
 * gesture handlers and the chat controller outside any one React subtree) +
 * useSyncExternalStore, mirroring `view-chat-binding.ts`.
 */

export type ShellSurfacePage = HomeLauncherPage;

export interface ShellSurfaceState {
  /** Which half of the launcher rail is showing. */
  readonly page: ShellSurfacePage;
  /** Active page index within the launcher's icon grid (0-based). */
  readonly launcherPage: number;
  /** Total launcher icon-grid pages, reported by the launcher surface. */
  readonly launcherPageCount: number;
}

const INITIAL_STATE: ShellSurfaceState = {
  page: "home",
  launcherPage: 0,
  launcherPageCount: 1,
};

interface SurfaceStore {
  state: ShellSurfaceState;
  listeners: Set<() => void>;
  bridgedWindow?: Pick<Window, "addEventListener">;
}

/**
 * Enforce the cross-field invariants on every transition so no caller can
 * produce an inconsistent surface state:
 *  - off the launcher ⇒ always page 0;
 *  - the active page is always clamped into [0, pageCount).
 */
function normalize(next: ShellSurfaceState): ShellSurfaceState {
  const pageCount = Math.max(1, Math.floor(next.launcherPageCount));
  if (next.page !== "launcher") {
    return {
      page: next.page,
      launcherPage: 0,
      launcherPageCount: pageCount,
    };
  }
  const launcherPage = Math.min(
    Math.max(0, Math.floor(next.launcherPage)),
    pageCount - 1,
  );
  return {
    page: "launcher",
    launcherPage,
    launcherPageCount: pageCount,
  };
}

function statesEqual(a: ShellSurfaceState, b: ShellSurfaceState): boolean {
  return (
    a.page === b.page &&
    a.launcherPage === b.launcherPage &&
    a.launcherPageCount === b.launcherPageCount
  );
}

function store(): SurfaceStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.shell-surface-store");
  const existing = g[k] as SurfaceStore | undefined;
  if (existing) {
    ensureWindowBridge(existing);
    return existing;
  }
  const created: SurfaceStore = {
    state: INITIAL_STATE,
    listeners: new Set(),
  };
  g[k] = created;
  ensureWindowBridge(created);
  return created;
}

function ensureWindowBridge(s: SurfaceStore): void {
  // Bridge the legacy `eliza:home-launcher:navigate` window event into the
  // store so existing dispatchers (useShellController.navigateHome /
  // navigateToLauncher) keep driving the same single source of truth. The
  // store never re-dispatches the event, so there is no feedback loop.
  if (typeof window !== "undefined") {
    if (s.bridgedWindow === window) return;
    window.addEventListener(HOME_LAUNCHER_NAV_EVENT, (event: Event) => {
      const detail = (event as CustomEvent<HomeLauncherNavigationDetail>)
        .detail;
      commit(s, { ...s.state, page: detail?.page ?? "home" });
    });
    s.bridgedWindow = window;
  }
}

function commit(s: SurfaceStore, next: ShellSurfaceState): void {
  const normalized = normalize(next);
  if (statesEqual(s.state, normalized)) return;
  s.state = normalized;
  for (const l of s.listeners) l();
}

function update(partial: Partial<ShellSurfaceState>): void {
  const s = store();
  commit(s, { ...s.state, ...partial });
}

// ── Imperative actions (callable from gesture handlers + non-React code) ──────

export function goHome(): void {
  update({ page: "home" });
}

export function goLauncher(): void {
  update({ page: "launcher" });
}

export function setShellSurfacePage(page: ShellSurfacePage): void {
  update({ page });
}

export function setLauncherPage(index: number): void {
  update({ launcherPage: index });
}

export function setLauncherPageCount(count: number): void {
  update({ launcherPageCount: count });
}

/** Read the surface state imperatively (tests / non-React callers). */
export function getShellSurface(): ShellSurfaceState {
  return store().state;
}

/** Reset to defaults. Test-only — the app never returns to the initial state. */
export function resetShellSurfaceForTests(): void {
  const s = store();
  s.state = INITIAL_STATE;
  for (const l of s.listeners) l();
}

// ── React bindings ────────────────────────────────────────────────────────────

export function useShellSurface(): ShellSurfaceState {
  const s = store();
  return React.useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    () => s.state,
    () => s.state,
  );
}
