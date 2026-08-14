/**
 * Single source of truth for which half of the home↔launcher rail is showing,
 * so one model owns navigation instead of four uncoordinated state machines.
 * Module-level store shared via globalThis + useSyncExternalStore.
 *
 * Persisted to localStorage to survive shell remounts during async operations
 * like auth probes (#19325). Onboarding completion can transition chat to
 * half-detent while auth probe runs; without persistence, the shell remount
 * resets state to "home", collapsing the chat.
 */
import * as React from "react";

/**
 * Shell-surface store — the SINGLE source of truth for which half of the
 * home ↔ launcher rail is showing.
 *
 * Before this store there were four uncoordinated navigation state machines
 * (the route `tab`, HomeLauncherSurface's local `page`, the Launcher's local
 * page + `editing`, and the chat overlay's `mode`). Because no single thing
 * owned "which launcher screen am I on", a horizontal swipe was claimed by two
 * machines at once and the launcher's `editing` flag survived navigation. This
 * store collapses that navigation into one model that every surface DERIVES
 * from.
 *
 * Module-level store shared via globalThis (survives HMR + reachable from the
 * gesture handlers and the chat controller outside any one React subtree) +
 * useSyncExternalStore, mirroring `view-chat-binding.ts`.
 */

export type HomeLauncherPage = "home" | "launcher";

export interface ShellSurfaceState {
  /** Which half of the launcher rail is showing. */
  readonly page: HomeLauncherPage;
}

const INITIAL_STATE: ShellSurfaceState = { page: "home" };
const SHELL_SURFACE_STORAGE_KEY = "eliza:shell-surface-page";

interface SurfaceStore {
  state: ShellSurfaceState;
  listeners: Set<() => void>;
}

/**
 * Load the persisted shell surface page from localStorage.
 * Returns the persisted page if valid, otherwise undefined (use default).
 */
function loadPersistedShellSurfacePage(): HomeLauncherPage | undefined {
  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }
  try {
    const stored = window.localStorage.getItem(SHELL_SURFACE_STORAGE_KEY);
    if (stored === "launcher" || stored === "home") {
      return stored;
    }
  } catch {
    // error-policy:J3 localStorage may be unavailable (privacy mode / disabled
    // storage); treat as no persisted state
  }
  return undefined;
}

/**
 * Persist the shell surface page to localStorage.
 * Called whenever the page changes to ensure the state survives shell remounts.
 */
function savePersistedShellSurfacePage(page: HomeLauncherPage): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(SHELL_SURFACE_STORAGE_KEY, page);
  } catch {
    // error-policy:J6 best-effort persistence — if storage write fails,
    // the state lives in memory until the next navigation. Failures are
    // graceful degradation only.
  }
}

function store(): SurfaceStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.shell-surface-store");
  const existing = g[k] as SurfaceStore | undefined;
  if (existing) return existing;
  // Restore from localStorage to survive shell remounts (issue #19325).
  // If no persisted state exists, use the default "home".
  const persisted = loadPersistedShellSurfacePage();
  const initialPage: HomeLauncherPage = persisted ?? INITIAL_STATE.page;
  const created: SurfaceStore = {
    state: { page: initialPage },
    listeners: new Set(),
  };
  g[k] = created;
  return created;
}

function commit(s: SurfaceStore, page: HomeLauncherPage): void {
  if (s.state.page === page) return;
  s.state = { page };
  // Persist to localStorage so the state survives shell remounts during
  // async operations like auth probes (#19325).
  savePersistedShellSurfacePage(page);
  for (const l of s.listeners) l();
}

// ── Imperative actions (callable from gesture handlers + non-React code) ──────

export function goHome(): void {
  commit(store(), "home");
}

export function goLauncher(): void {
  commit(store(), "launcher");
}

export function setShellSurfacePage(page: HomeLauncherPage): void {
  commit(store(), page);
}

/** Read the surface state imperatively (tests / non-React callers). */
export function getShellSurface(): ShellSurfaceState {
  return store().state;
}

/** Reset to defaults. Test-only — the app never returns to the initial state. */
export function resetShellSurfaceForTests(): void {
  const s = store();
  s.state = INITIAL_STATE;
  try {
    window.localStorage?.removeItem(SHELL_SURFACE_STORAGE_KEY);
  } catch {
    // error-policy:J6 best-effort test cleanup
  }
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
