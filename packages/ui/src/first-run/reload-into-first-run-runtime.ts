/**
 * Helper for the Settings > Runtime panel "Switch runtime" action.
 */

import { shellLocalStorage } from "../surface-realm-channel";
import {
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  persistMobileRuntimeModeForServerTarget,
} from "./mobile-runtime-mode";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
export const FIRST_RUN_QUERY_NAME = "runtime";
export const FIRST_RUN_QUERY_VALUE = "first-run";
export const FIRST_RUN_TARGET_QUERY_NAME = "runtimeTarget";

export type FirstRunReloadTarget = "cloud" | "local" | "remote";

export function reloadIntoFirstRunRuntime(target?: FirstRunReloadTarget): void {
  if (typeof window === "undefined") return;
  persistMobileRuntimeModeForServerTarget("");
  try {
    shellLocalStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
  } catch {
    // error-policy:J6 best-effort cleanup — the query navigation below still
    // forces first-run when storage is unavailable
  }
  const url = new URL(window.location.href);
  url.searchParams.set(FIRST_RUN_QUERY_NAME, FIRST_RUN_QUERY_VALUE);
  if (target) {
    url.searchParams.set(FIRST_RUN_TARGET_QUERY_NAME, target);
  } else {
    url.searchParams.delete(FIRST_RUN_TARGET_QUERY_NAME);
  }
  window.location.href = url.toString();
}

export const __TEST_ONLY__ = {
  ACTIVE_SERVER_STORAGE_KEY,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
};
