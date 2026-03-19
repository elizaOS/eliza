/**
 * React hook for managing the overlay layout.
 *
 * Persistence strategy (dual-layer):
 *  1. **Server API** (`GET/POST /api/stream/overlay-layout`) — authoritative
 *     source that persists across headless browser restarts on a VPS.
 *  2. **localStorage** (`milady.stream.overlay-layout.v1`) — fast local cache,
 *     used as initial state and fallback when the server is unreachable.
 *
 * On mount the hook loads from localStorage (instant), then fetches from the
 * server. If the server has a layout, it wins. Mutations write to both.
 *
 * When `destinationId` is provided, the hook reads/writes destination-specific
 * storage (both localStorage and server). Falls back to the global default.
 */

import { client } from "@elizaos/app-core/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAllWidgets } from "./registry";
import type { OverlayLayout, WidgetInstance, WidgetPosition } from "./types";

function storageKey(destinationId?: string | null): string {
  const base = "milady.stream.overlay-layout.v1";
  return destinationId ? `${base}.${destinationId}` : base;
}

// ---------------------------------------------------------------------------
// Default layout — ThoughtBubble + Branding enabled, rest disabled
// ---------------------------------------------------------------------------

let _idCounter = 0;
function localId(): string {
  _idCounter += 1;
  return `w${Date.now().toString(36)}${_idCounter.toString(36)}`;
}

function buildDefaultLayout(): OverlayLayout {
  const widgets: WidgetInstance[] = getAllWidgets().map((def) => ({
    id: localId(),
    type: def.type,
    enabled: def.type === "thought-bubble" || def.type === "branding",
    position: { ...def.defaultPosition },
    zIndex: def.defaultZIndex,
    config: { ...def.defaultConfig },
  }));

  return { version: 1, name: "Default", widgets };
}

function loadLayoutLocal(destinationId?: string | null): OverlayLayout {
  try {
    const raw = localStorage.getItem(storageKey(destinationId));
    if (raw) {
      const parsed = JSON.parse(raw) as OverlayLayout;
      if (parsed.version === 1 && Array.isArray(parsed.widgets)) return parsed;
    }
  } catch {
    // corrupted — fall through to default
  }
  return buildDefaultLayout();
}

function saveLayoutLocal(
  layout: OverlayLayout,
  destinationId?: string | null,
): void {
  try {
    localStorage.setItem(storageKey(destinationId), JSON.stringify(layout));
  } catch {
    // storage full — silently skip
  }
}

/** Best-effort save to server. Non-blocking, non-fatal. */
function saveLayoutServer(
  layout: OverlayLayout,
  destinationId?: string | null,
): void {
  client.saveOverlayLayout(layout, destinationId).catch(() => {
    // Server may be unavailable (e.g. desktop dev mode) — ignore
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseOverlayLayout {
  layout: OverlayLayout;
  addWidget: (type: string) => void;
  removeWidget: (id: string) => void;
  toggleWidget: (id: string) => void;
  updateWidget: (
    id: string,
    patch: Partial<Pick<WidgetInstance, "position" | "zIndex" | "config">>,
  ) => void;
  moveWidget: (id: string, position: WidgetPosition) => void;
  resetLayout: () => void;
}

export function useOverlayLayout(
  destinationId?: string | null,
): UseOverlayLayout {
  const [layout, setLayout] = useState<OverlayLayout>(() =>
    loadLayoutLocal(destinationId),
  );
  const serverFetched = useRef<string | null | undefined>(undefined);

  // Re-fetch when destinationId changes
  useEffect(() => {
    // Reset to local cache for new destination
    setLayout(loadLayoutLocal(destinationId));
    serverFetched.current = undefined;
  }, [destinationId]);

  // On mount / destination change: try to fetch authoritative layout from server
  useEffect(() => {
    if (serverFetched.current === destinationId) return;
    serverFetched.current = destinationId;

    client
      .getOverlayLayout(destinationId)
      .then((res) => {
        const remote = res.layout as OverlayLayout | null;
        if (remote && remote.version === 1 && Array.isArray(remote.widgets)) {
          setLayout(remote);
          saveLayoutLocal(remote, destinationId);
        }
      })
      .catch(() => {
        // Server unavailable — use local/default layout
      });
  }, [destinationId]);

  // Persist to both layers on change (skip the initial load from useEffect)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    saveLayoutLocal(layout, destinationId);
    saveLayoutServer(layout, destinationId);
  }, [layout, destinationId]);

  const addWidget = useCallback((type: string) => {
    const defs = getAllWidgets();
    const def = defs.find((d) => d.type === type);
    if (!def) return;

    const instance: WidgetInstance = {
      id: localId(),
      type: def.type,
      enabled: true,
      position: { ...def.defaultPosition },
      zIndex: def.defaultZIndex,
      config: { ...def.defaultConfig },
    };

    setLayout((prev) => ({
      ...prev,
      widgets: [...prev.widgets, instance],
    }));
  }, []);

  const removeWidget = useCallback((id: string) => {
    setLayout((prev) => ({
      ...prev,
      widgets: prev.widgets.filter((w) => w.id !== id),
    }));
  }, []);

  const toggleWidget = useCallback((id: string) => {
    setLayout((prev) => ({
      ...prev,
      widgets: prev.widgets.map((w) =>
        w.id === id ? { ...w, enabled: !w.enabled } : w,
      ),
    }));
  }, []);

  const updateWidget = useCallback(
    (
      id: string,
      patch: Partial<Pick<WidgetInstance, "position" | "zIndex" | "config">>,
    ) => {
      setLayout((prev) => ({
        ...prev,
        widgets: prev.widgets.map((w) =>
          w.id === id ? { ...w, ...patch } : w,
        ),
      }));
    },
    [],
  );

  const moveWidget = useCallback((id: string, position: WidgetPosition) => {
    setLayout((prev) => ({
      ...prev,
      widgets: prev.widgets.map((w) => (w.id === id ? { ...w, position } : w)),
    }));
  }, []);

  const resetLayout = useCallback(() => {
    const fresh = buildDefaultLayout();
    setLayout(fresh);
  }, []);

  return {
    layout,
    addWidget,
    removeWidget,
    toggleWidget,
    updateWidget,
    moveWidget,
    resetLayout,
  };
}
