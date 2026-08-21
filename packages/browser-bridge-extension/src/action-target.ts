/**
 * Resolves the exact browser tab and window an agent action will affect so the
 * authorization decision and extension API call cannot disagree about the
 * destination, including across incognito and multi-window sessions.
 */
import type { BrowserBridgeActionKind } from "./browser-bridge-contracts";
import type { ExtensionTab, ExtensionWindow } from "./webextension";

export interface BrowserActionTarget {
  tabId: number | null;
  windowId: number | null;
  incognito: boolean;
  focusedActive: boolean;
}

function parseBrowserId(
  label: string,
  value: string | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a positive integer browser identifier.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the safe browser identifier range.`);
  }
  return parsed;
}

function firstDefined<T>(...values: Array<T | null>): T | null {
  return values.find((value): value is T => value !== null) ?? null;
}

export function resolveBrowserActionTarget(args: {
  actionKind: BrowserBridgeActionKind;
  actionTabId?: string | null;
  sessionTabId?: string | null;
  currentTabId: number | null;
  actionWindowId?: string | null;
  sessionWindowId?: string | null;
  tabs: readonly ExtensionTab[];
  windows: readonly ExtensionWindow[];
  focusedTab: ExtensionTab | null;
}): BrowserActionTarget {
  const requestedTabId = firstDefined(
    parseBrowserId("action.tabId", args.actionTabId),
    parseBrowserId("session.tabId", args.sessionTabId),
    args.currentTabId,
  );
  const requestedWindowId = firstDefined(
    parseBrowserId("action.windowId", args.actionWindowId),
    parseBrowserId("session.windowId", args.sessionWindowId),
  );

  let targetTab =
    requestedTabId === null
      ? null
      : (args.tabs.find((tab) => tab.id === requestedTabId) ?? null);
  if (requestedTabId !== null && !targetTab) {
    throw new Error(`Browser tab ${requestedTabId} is no longer available.`);
  }
  if (
    targetTab &&
    requestedWindowId !== null &&
    targetTab.windowId !== requestedWindowId
  ) {
    throw new Error(
      `Browser tab ${requestedTabId} does not belong to window ${requestedWindowId}.`,
    );
  }

  const destinationWindowId = firstDefined(
    requestedWindowId,
    targetTab?.windowId ?? null,
    args.focusedTab?.windowId ?? null,
  );
  if (requestedWindowId !== null) {
    const windowExists =
      args.windows.some((window) => window.id === requestedWindowId) ||
      args.tabs.some((tab) => tab.windowId === requestedWindowId);
    if (!windowExists) {
      throw new Error(
        `Browser window ${requestedWindowId} is no longer available.`,
      );
    }
  }

  if (!targetTab && args.actionKind !== "open") {
    targetTab =
      args.tabs.find(
        (tab) => tab.windowId === destinationWindowId && tab.active === true,
      ) ??
      (destinationWindowId === null ||
      args.focusedTab?.windowId === destinationWindowId
        ? args.focusedTab
        : null);
  }

  const destinationWindow = args.windows.find(
    (window) => window.id === destinationWindowId,
  );
  const destinationIncognito =
    destinationWindow?.incognito ??
    targetTab?.incognito ??
    args.tabs.find((tab) => tab.windowId === destinationWindowId)?.incognito ??
    false;

  return {
    tabId: targetTab?.id ?? null,
    windowId: destinationWindowId,
    incognito: destinationIncognito,
    focusedActive:
      args.actionKind === "open"
        ? destinationWindowId !== null &&
          destinationWindowId === args.focusedTab?.windowId &&
          args.focusedTab.active === true
        : targetTab !== null &&
          targetTab.id === args.focusedTab?.id &&
          targetTab.active === true,
  };
}
