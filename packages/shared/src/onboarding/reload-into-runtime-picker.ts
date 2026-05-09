/**
 * Helper for the Settings ▸ Runtime panel "Switch runtime" action.
 *
 * Clears the persisted ElizaOS runtime selection (mobile-runtime-mode +
 * active-server in localStorage), then navigates to the current URL with
 * `?runtime=picker` appended. The query flag is consumed by
 * `RuntimeGate.hasPickerOverride()` so the ElizaOS auto-local branch is
 * bypassed and the chooser tiles render — the user can then pick Cloud /
 * Remote / Local without the picker auto-completing back to local.
 *
 * This file is deliberately a leaf module with zero React or runtime
 * dependencies so its contract can be tested without booting the
 * SettingsView dependency graph (which transitively imports the API
 * client and reads localStorage at module init).
 */

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

export const RUNTIME_PICKER_QUERY_NAME = "runtime";
export const RUNTIME_PICKER_QUERY_VALUE = "picker";

export function reloadIntoRuntimePicker(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MOBILE_RUNTIME_MODE_STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
  } catch {
    // localStorage unreachable in some embedded shells; the picker query
    // alone is still enough to surface the chooser on the next render.
  }
  const url = new URL(window.location.href);
  url.searchParams.set(RUNTIME_PICKER_QUERY_NAME, RUNTIME_PICKER_QUERY_VALUE);
  window.location.href = url.toString();
}

export const __TEST_ONLY__ = {
  ACTIVE_SERVER_STORAGE_KEY,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
};
