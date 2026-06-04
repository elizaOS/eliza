// WindowManager context + types + the useWindowManager hook, split out of
// WindowManager.tsx so that file exports only the WindowManagerProvider
// component and stays Fast-Refresh-compatible. The provider (in the .tsx)
// supplies this context; views read it via useWindowManager.
import { createContext, useContext } from "react";

// The icon is a lucide icon NAME (e.g. "StickyNote"), resolved to a component
// by the dock's explicit name→component map. We keep it a plain string here so
// the registry stays serializable-shaped data and the manager never imports
// lucide — only the presentational dock does.
export interface WindowMeta {
  /** Human-readable window title shown on the dock chip. */
  label: string;
  /** A lucide-react icon name (e.g. "Calendar"); resolved by the dock. */
  icon: string;
  /** Close the underlying view (the dock chip's × calls this so closing a
   *  minimized window truly closes it instead of resurrecting its panel).
   *  useWindowControls passes a stable wrapper, so its identity never churns. */
  onClose?: () => void;
}

export interface WindowEntry extends WindowMeta {
  /** Stable window id — the same storageKey the view passes to useWindowControls. */
  id: string;
  /** Whether the window is currently minimized to the dock. */
  minimized: boolean;
}

export interface WindowManagerApi {
  /** Register (or refresh the meta of) a window. Idempotent on re-register;
   *  preserves the existing `minimized` flag so a meta refresh never restores. */
  register(id: string, meta: WindowMeta): void;
  /** Remove a window from the registry entirely (its dock chip disappears). */
  unregister(id: string): void;
  /** Flip a window's minimized flag. No-op for an unregistered id. */
  setMinimized(id: string, minimized: boolean): void;
  /** Read a single window's minimized flag (false when unregistered). */
  isMinimized(id: string): boolean;
  /** The windows currently minimized, in stable insertion order. */
  minimizedWindows: WindowEntry[];
}

export const WindowManagerContext = createContext<WindowManagerApi | null>(
  null,
);

/**
 * Access the window manager. Returns `null` when called outside a
 * WindowManagerProvider — callers (useWindowControls) must degrade gracefully
 * rather than throw, so a view rendered standalone (tests, storybook, a host
 * that hasn't wrapped the shell) never breaks.
 */
export function useWindowManager(): WindowManagerApi | null {
  return useContext(WindowManagerContext);
}
