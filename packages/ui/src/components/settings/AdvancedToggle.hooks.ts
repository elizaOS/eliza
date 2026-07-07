/**
 * Shared state + hook for the "advanced settings" toggle.
 *
 * The on/off flag persists to `localStorage` under `ADVANCED_TOGGLE_STORAGE_KEY`
 * and is broadcast across every `<AdvancedToggle />` and
 * `useAdvancedSettingsEnabled()` subscriber via a single module-level listener
 * set — so this module must stay the one source of that set.
 */

import { useEffect, useState } from "react";
import { shellLocalStorage } from "../../surface-realm-channel";

export const ADVANCED_TOGGLE_STORAGE_KEY = "eliza:settings-advanced";

type Listener = (enabled: boolean) => void;
export const advancedToggleListeners = new Set<Listener>();

export function readPersistedAdvancedFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ADVANCED_TOGGLE_STORAGE_KEY) === "1";
  } catch {
    // error-policy:J3 storage unavailable — the toggle starts at its default
    // (off) instead of wedging settings.
    return false;
  }
}

export function writePersistedAdvancedFlag(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // error-policy:J6 localStorage may be unavailable (e.g. iframe with
    // denied storage) — the in-memory listener cascade still works.
  }
}

export function publishAdvancedFlag(enabled: boolean): void {
  for (const listener of advancedToggleListeners) listener(enabled);
}

/**
 * Hook: subscribe to the persisted advanced-settings flag. Reads from
 * `localStorage` on mount and updates whenever any `<AdvancedToggle />`
 * elsewhere on the page flips state.
 */
export function useAdvancedSettingsEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(readPersistedAdvancedFlag);

  useEffect(() => {
    setEnabled(readPersistedAdvancedFlag());
    advancedToggleListeners.add(setEnabled);

    const onStorage = (event: StorageEvent) => {
      if (event.key === ADVANCED_TOGGLE_STORAGE_KEY) {
        setEnabled(event.newValue === "1");
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
    }

    return () => {
      advancedToggleListeners.delete(setEnabled);
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
    };
  }, []);

  return enabled;
}
