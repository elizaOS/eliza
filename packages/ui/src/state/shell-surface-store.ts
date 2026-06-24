import * as React from "react";
import {
  HOME_SPRINGBOARD_NAV_EVENT,
  type HomeSpringboardNavigationDetail,
  type HomeSpringboardPage,
} from "../components/shell/home-springboard-events";

/**
 * Shell-surface store — the SINGLE source of truth for the home/springboard
 * launcher's navigation state.
 *
 * Before this store there were four uncoordinated navigation state machines
 * (the route `tab`, HomeSpringboardSurface's local `page`, the Springboard's
 * local `page` + `editing`, and the chat overlay's `mode`). Because no single
 * thing owned "which launcher screen am I on", a horizontal swipe was claimed by
 * two machines, two page-indicators rendered at once, and the springboard's
 * `editing` flag survived navigation — leaving the user stranded in jiggle mode
 * with no way back. This store collapses the launcher's navigation (machines 2
 * and 3) into one model that every surface DERIVES from.
 *
 * The non-negotiable invariant lives here, not in a component: leaving the
 * springboard (page !== "springboard") ALWAYS resets the transient sub-state
 * (`springboardEditing` → false, `springboardPage` → 0). That makes the
 * "swipe-back lands in edit mode / re-entering is still jiggling" class of bug
 * structurally impossible regardless of how the user left the surface.
 *
 * Module-level store shared via globalThis (survives HMR + reachable from the
 * gesture handlers and the chat controller outside any one React subtree) +
 * useSyncExternalStore, mirroring `view-chat-binding.ts`.
 */

export type ShellSurfacePage = HomeSpringboardPage;

export interface ShellSurfaceState {
  /** Which half of the launcher rail is showing. */
  readonly page: ShellSurfacePage;
  /** Active page index within the springboard's icon grid (0-based). */
  readonly springboardPage: number;
  /** Total springboard icon-grid pages, reported by the springboard surface. */
  readonly springboardPageCount: number;
  /** Whether the springboard is in edit/jiggle mode. */
  readonly springboardEditing: boolean;
}

const INITIAL_STATE: ShellSurfaceState = {
  page: "home",
  springboardPage: 0,
  springboardPageCount: 1,
  springboardEditing: false,
};

interface SurfaceStore {
  state: ShellSurfaceState;
  listeners: Set<() => void>;
  bridgedWindow?: Pick<Window, "addEventListener">;
}

/**
 * Enforce the cross-field invariants on every transition so no caller can
 * produce an inconsistent surface state:
 *  - off the springboard ⇒ never editing, always page 0;
 *  - the active page is always clamped into [0, pageCount).
 */
function normalize(next: ShellSurfaceState): ShellSurfaceState {
  const pageCount = Math.max(1, Math.floor(next.springboardPageCount));
  if (next.page !== "springboard") {
    return {
      page: next.page,
      springboardPage: 0,
      springboardPageCount: pageCount,
      springboardEditing: false,
    };
  }
  const springboardPage = Math.min(
    Math.max(0, Math.floor(next.springboardPage)),
    pageCount - 1,
  );
  return {
    page: "springboard",
    springboardPage,
    springboardPageCount: pageCount,
    springboardEditing: next.springboardEditing,
  };
}

function statesEqual(a: ShellSurfaceState, b: ShellSurfaceState): boolean {
  return (
    a.page === b.page &&
    a.springboardPage === b.springboardPage &&
    a.springboardPageCount === b.springboardPageCount &&
    a.springboardEditing === b.springboardEditing
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
  // Bridge the legacy `eliza:home-springboard:navigate` window event into the
  // store so existing dispatchers (useShellController.navigateHome /
  // navigateToSpringboard) keep driving the same single source of truth. The
  // store never re-dispatches the event, so there is no feedback loop.
  if (typeof window !== "undefined") {
    if (s.bridgedWindow === window) return;
    window.addEventListener(HOME_SPRINGBOARD_NAV_EVENT, (event: Event) => {
      const detail = (event as CustomEvent<HomeSpringboardNavigationDetail>)
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

export function goSpringboard(): void {
  update({ page: "springboard" });
}

export function setShellSurfacePage(page: ShellSurfacePage): void {
  update({ page });
}

export function setSpringboardPage(index: number): void {
  update({ springboardPage: index });
}

export function setSpringboardPageCount(count: number): void {
  update({ springboardPageCount: count });
}

export function setSpringboardEditing(editing: boolean): void {
  update({ springboardEditing: editing });
}

export function enterSpringboardEdit(): void {
  update({ springboardEditing: true });
}

export function exitSpringboardEdit(): void {
  update({ springboardEditing: false });
}

export function toggleSpringboardEdit(): void {
  const s = store();
  update({ springboardEditing: !s.state.springboardEditing });
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
