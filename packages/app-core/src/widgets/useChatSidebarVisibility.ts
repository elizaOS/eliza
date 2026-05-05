/**
 * React hook over the chat-sidebar widget visibility overrides.
 *
 * - Reads the persisted state from localStorage on mount.
 * - Subscribes to cross-window `storage` events so two tabs stay in sync.
 * - Persists every mutation immediately and bumps internal state.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY,
  isWidgetVisible,
  loadChatSidebarVisibility,
  saveChatSidebarVisibility,
  type VisibilityCandidate,
  type WidgetVisibilityState,
  widgetVisibilityKey,
} from "./visibility";

export interface ChatSidebarVisibilityHook {
  overrides: Record<string, boolean>;
  isVisible(candidate: VisibilityCandidate): boolean;
  setVisible(candidate: VisibilityCandidate, next: boolean): void;
  reset(): void;
}

export function useChatSidebarVisibility(): ChatSidebarVisibilityHook {
  const [state, setState] = useState<WidgetVisibilityState>(() =>
    loadChatSidebarVisibility(),
  );

  // Cross-tab sync: another window writing to the same key updates this one.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(event: StorageEvent): void {
      if (event.key !== CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY) return;
      setState(loadChatSidebarVisibility());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setVisible = useCallback(
    (candidate: VisibilityCandidate, next: boolean) => {
      setState((prev) => {
        const key = widgetVisibilityKey(candidate.pluginId, candidate.id);
        const defaultEnabled = candidate.defaultEnabled !== false;

        // If the requested state matches the default, drop the explicit
        // override so future default flips propagate naturally.
        const nextOverrides = { ...prev.overrides };
        if (next === defaultEnabled) {
          delete nextOverrides[key];
        } else {
          nextOverrides[key] = next;
        }
        const nextState: WidgetVisibilityState = { overrides: nextOverrides };
        saveChatSidebarVisibility(nextState);
        return nextState;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    const nextState: WidgetVisibilityState = { overrides: {} };
    saveChatSidebarVisibility(nextState);
    setState(nextState);
  }, []);

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
