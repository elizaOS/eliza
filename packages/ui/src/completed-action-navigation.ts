/**
 * Deduplicates the targeted-WebSocket and terminal-chat delivery paths for one
 * completed VIEWS action. A mounted shell can acknowledge the cancelable event;
 * an unhandled first delivery instead records its route epoch so intervening
 * user navigation wins over a late fallback.
 */

import type { NavigateViewDetail } from "@elizaos/shared/events";
import {
  NAVIGATE_VIEW_EVENT,
  normalizeCompletedActionHandoffId,
} from "@elizaos/shared/events";
import { getWindowNavigationPath } from "./navigation";

const MAX_TRACKED_HANDOFFS = 256;
const handledHandoffs = new Set<string>();
const pendingHandoffs = new Map<
  string,
  { navigationEpoch: number; path: string }
>();
let navigationEpoch = 0;
let observedWindow: Window | undefined;

function advanceNavigationEpoch(): void {
  navigationEpoch += 1;
}

function observeNavigationEpoch(): void {
  if (typeof window === "undefined" || observedWindow === window) return;
  observedWindow?.removeEventListener("popstate", advanceNavigationEpoch);
  observedWindow?.removeEventListener("hashchange", advanceNavigationEpoch);
  observedWindow = window;
  observedWindow.addEventListener("popstate", advanceNavigationEpoch);
  observedWindow.addEventListener("hashchange", advanceNavigationEpoch);
}

function rememberHandledHandoff(id: string): void {
  pendingHandoffs.delete(id);
  handledHandoffs.delete(id);
  handledHandoffs.add(id);
  while (handledHandoffs.size > MAX_TRACKED_HANDOFFS) {
    const oldest = handledHandoffs.values().next().value;
    if (typeof oldest !== "string") break;
    handledHandoffs.delete(oldest);
  }
}

function rememberPendingHandoff(
  id: string,
  snapshot: { navigationEpoch: number; path: string },
): void {
  pendingHandoffs.delete(id);
  pendingHandoffs.set(id, snapshot);
  while (pendingHandoffs.size > MAX_TRACKED_HANDOFFS) {
    const oldest = pendingHandoffs.keys().next().value;
    if (typeof oldest !== "string") break;
    pendingHandoffs.delete(oldest);
  }
}

/** Dispatch once unless the mounted shell already handled the same handoff. */
export function dispatchCompletedActionNavigation(
  detail: NavigateViewDetail,
): boolean {
  if (typeof window === "undefined") return false;
  observeNavigationEpoch();
  const id = normalizeCompletedActionHandoffId(detail.completedActionHandoffId);
  if (id && handledHandoffs.has(id)) return false;

  const path = getWindowNavigationPath();
  const pending = id ? pendingHandoffs.get(id) : undefined;
  if (
    id &&
    pending &&
    (pending.navigationEpoch !== navigationEpoch || pending.path !== path)
  ) {
    // An unhandled transport frame is not permission to override a navigation
    // the user made while the terminal fallback was still in flight. Retire
    // the id so a later duplicate cannot pull the renderer back either.
    rememberHandledHandoff(id);
    return false;
  }

  const snapshot = { navigationEpoch, path };
  const event = new CustomEvent<NavigateViewDetail>(NAVIGATE_VIEW_EVENT, {
    detail,
    cancelable: true,
  });
  window.dispatchEvent(event);
  if (id) {
    if (event.defaultPrevented) rememberHandledHandoff(id);
    else if (!pending) rememberPendingHandoff(id, snapshot);
  }
  return true;
}

/** Mark a handoff handled from a shell listener before performing navigation. */
export function markCompletedActionNavigationHandled(
  event: Event,
  detail: NavigateViewDetail | undefined,
): void {
  if (
    !event.cancelable ||
    !normalizeCompletedActionHandoffId(detail?.completedActionHandoffId)
  ) {
    return;
  }
  event.preventDefault();
}

/** Test-only reset for module-scoped renderer delivery history. */
export function resetCompletedActionNavigationForTests(): void {
  handledHandoffs.clear();
  pendingHandoffs.clear();
  observedWindow?.removeEventListener("popstate", advanceNavigationEpoch);
  observedWindow?.removeEventListener("hashchange", advanceNavigationEpoch);
  observedWindow = undefined;
  navigationEpoch = 0;
}
