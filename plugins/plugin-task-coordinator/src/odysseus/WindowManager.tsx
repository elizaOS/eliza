// WindowManager — the core of odysseus's minimize-to-dock window system
// (static/js/modalManager.js `_state` map + `_renderDock`). A single React
// context owns the registry of every tool window that opted into minimize:
// id → { id, label, icon, minimized }. Tool views register on mount (and
// unregister on unmount) via useWindowControls; the MinimizedDock subscribes
// to the derived list of currently-minimized windows and renders a chip each.
//
// Why a context instead of the module-global Map the odysseus source uses: in
// React the dock and the windows are sibling components, so the minimized set
// has to be reactive state that re-renders the dock when a window minimizes.
// The provider holds that state; the registry entries themselves are plain
// data (no DOM handles — restore/close run through the React tree, not by
// toggling `.hidden` on a detached element).

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

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

const WindowManagerContext = createContext<WindowManagerApi | null>(null);

export function WindowManagerProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  // Insertion-ordered registry. A Map preserves the order windows registered
  // in, so the dock chips stay in a stable order across minimize/restore
  // cycles (parity with modalManager.js `_dockOrder`, which only drops an id
  // on full close — here, on unregister).
  const [registry, setRegistry] = useState<Map<string, WindowEntry>>(
    () => new Map(),
  );

  const register = useCallback((id: string, meta: WindowMeta) => {
    setRegistry((prev) => {
      const existing = prev.get(id);
      // Re-register only rewrites meta; a window that was minimized stays
      // minimized (a remount/meta-refresh must not silently restore it).
      const next: WindowEntry = {
        id,
        label: meta.label,
        icon: meta.icon,
        onClose: meta.onClose,
        minimized: existing?.minimized ?? false,
      };
      // Skip the state churn when nothing actually changed (avoids a needless
      // re-render when a view re-registers with identical meta on every render).
      if (
        existing &&
        existing.label === next.label &&
        existing.icon === next.icon &&
        existing.minimized === next.minimized
      ) {
        return prev;
      }
      const copy = new Map(prev);
      copy.set(id, next);
      return copy;
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setRegistry((prev) => {
      if (!prev.has(id)) return prev;
      const copy = new Map(prev);
      copy.delete(id);
      return copy;
    });
  }, []);

  const setMinimized = useCallback((id: string, minimized: boolean) => {
    setRegistry((prev) => {
      const existing = prev.get(id);
      if (!existing || existing.minimized === minimized) return prev;
      const copy = new Map(prev);
      copy.set(id, { ...existing, minimized });
      return copy;
    });
  }, []);

  const isMinimized = useCallback(
    (id: string): boolean => registry.get(id)?.minimized === true,
    [registry],
  );

  const minimizedWindows = useMemo(
    () => [...registry.values()].filter((w) => w.minimized),
    [registry],
  );

  const api = useMemo<WindowManagerApi>(
    () => ({
      register,
      unregister,
      setMinimized,
      isMinimized,
      minimizedWindows,
    }),
    [register, unregister, setMinimized, isMinimized, minimizedWindows],
  );

  return (
    <WindowManagerContext.Provider value={api}>
      {children}
    </WindowManagerContext.Provider>
  );
}

/**
 * Access the window manager. Returns `null` when called outside a
 * WindowManagerProvider — callers (useWindowControls) must degrade gracefully
 * rather than throw, so a view rendered standalone (tests, storybook, a host
 * that hasn't wrapped the shell) never breaks.
 */
export function useWindowManager(): WindowManagerApi | null {
  return useContext(WindowManagerContext);
}
