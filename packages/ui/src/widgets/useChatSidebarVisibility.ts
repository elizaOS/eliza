/**
 * React hook over per-slot widget visibility overrides.
 *
 * - Reads the persisted state from localStorage on mount.
 * - Subscribes to cross-window `storage` events so two tabs stay in sync.
 * - Persists every mutation immediately and bumps internal state.
 */

import { useCallback, useEffect, useState } from "react";
import type { WidgetSlot } from "./types";
import {
  isWidgetVisible,
  loadWidgetVisibility,
  saveWidgetVisibility,
  type VisibilityCandidate,
  type WidgetVisibilityState,
  widgetVisibilityKey,
  widgetVisibilityStorageKey,
} from "./visibility";

export interface WidgetVisibilityHook {
  overrides: Record<string, boolean>;
  isVisible(candidate: VisibilityCandidate): boolean;
  setVisible(candidate: VisibilityCandidate, next: boolean): void;
  reset(): void;
}

export type ChatSidebarVisibilityHook = WidgetVisibilityHook;

export function useWidgetVisibility(
  slot: WidgetSlot = "chat-sidebar",
): WidgetVisibilityHook {
  const [state, setState] = useState<WidgetVisibilityState>(() =>
    loadWidgetVisibility(slot),
  );

  // Cross-tab sync: another window writing to the same key updates this one.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = widgetVisibilityStorageKey(slot);
    function onStorage(event: StorageEvent): void {
      if (event.key !== storageKey) return;
      setState(loadWidgetVisibility(slot));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [slot]);

  const setVisible = useCallback(
    (candidate: VisibilityCandidate, next: boolean) => {
      setState((prev) => {
        const key = widgetVisibilityKey(candidate.pluginId, candidate.id);
        const defaultEnabled = candidate.defaultEnabled !== false;

        // If the requested state matches the default, drop the explicit
        // override so later default changes propagate naturally.
        const nextOverrides = { ...prev.overrides };
        if (next === defaultEnabled) {
          delete nextOverrides[key];
        } else {
          nextOverrides[key] = next;
        }
        const nextState: WidgetVisibilityState = { overrides: nextOverrides };
        saveWidgetVisibility(nextState, slot);
        return nextState;
      });
    },
    [slot],
  );

  const reset = useCallback(() => {
    const nextState: WidgetVisibilityState = { overrides: {} };
    saveWidgetVisibility(nextState, slot);
    setState(nextState);
  }, [slot]);

  const isVisible = useCallback(
    (candidate: VisibilityCandidate) =>
      isWidgetVisible(candidate, state.overrides),
    [state.overrides],
  );

  return {
    overrides: state.overrides,
    isVisible,
    setVisible,
    reset,
  };
}

export function useChatSidebarVisibility(): ChatSidebarVisibilityHook {
  return useWidgetVisibility("chat-sidebar");
}
