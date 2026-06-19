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
//
// The context, types, and the useWindowManager hook live in
// ./WindowManager.context so this file exports only the provider component and
// stays Fast-Refresh-compatible.

import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  type WindowEntry,
  type WindowManagerApi,
  WindowManagerContext,
  type WindowMeta,
} from "./WindowManager.context";

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
