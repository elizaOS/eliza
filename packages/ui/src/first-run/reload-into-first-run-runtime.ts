/**
 * Helper for the Settings > Runtime panel "Switch runtime" action.
 */

import {
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  persistMobileRuntimeModeForServerTarget,
} from "./mobile-runtime-mode";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
export const FIRST_RUN_QUERY_NAME = "runtime";
export const FIRST_RUN_QUERY_VALUE = "first-run";
export const FIRST_RUN_TARGET_QUERY_NAME = "runtimeTarget";

export type FirstRunReloadTarget = "cloud" | "local" | "remote";

function isFirstRunReloadTarget(
  value: string | null,
): value is FirstRunReloadTarget {
  return value === "cloud" || value === "local" || value === "remote";
}

export function readFirstRunRuntimeTarget(
  search: string | URLSearchParams = typeof window === "undefined"
    ? ""
    : window.location.search,
): FirstRunReloadTarget | null {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const runtime = params.get(FIRST_RUN_QUERY_NAME);
  if (runtime !== FIRST_RUN_QUERY_VALUE) {
    return null;
  }
  const target = params.get(FIRST_RUN_TARGET_QUERY_NAME);
  return isFirstRunReloadTarget(target) ? target : "local";
}

export function reloadIntoFirstRunRuntime(target?: FirstRunReloadTarget): void {
  if (typeof window === "undefined") return;
  persistMobileRuntimeModeForServerTarget("");
  try {
    window.localStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
  } catch {
    // The query navigation still forces first-run when storage is unavailable.
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
