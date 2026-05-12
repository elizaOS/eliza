import type { BrowserBridgeSettings } from "@elizaos/plugin-browser";
import type { CompanionSyncRequest } from "./protocol";

export type RememberedTab = CompanionSyncRequest["tabs"][number];

function identityKey(
  tab: Pick<RememberedTab, "browser" | "profileId" | "windowId" | "tabId">,
): string {
  return `${tab.browser}:${tab.profileId}:${tab.windowId}:${tab.tabId}`;
}

function sortTabs(tabs: readonly RememberedTab[]): RememberedTab[] {
  return [...tabs].sort((left, right) => {
    const leftRank = left.focusedActive ? 3 : left.activeInWindow ? 2 : 1;
    const rightRank = right.focusedActive ? 3 : right.activeInWindow ? 2 : 1;
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }
    const leftAnchor = Date.parse(left.lastFocusedAt ?? left.lastSeenAt);
    const rightAnchor = Date.parse(right.lastFocusedAt ?? right.lastSeenAt);
    if (
      Number.isFinite(leftAnchor) &&
      Number.isFinite(rightAnchor) &&
      leftAnchor !== rightAnchor
    ) {
      return rightAnchor - leftAnchor;
    }
    return left.title.localeCompare(right.title);
  });
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

function tabOrigin(tab: Pick<RememberedTab, "url">): string | null {
  try {
    return normalizeOrigin(new URL(tab.url).origin);
  } catch {
    return null;
  }
}

function isTrackingPaused(settings: BrowserBridgeSettings, now: Date): boolean {
  return (
    typeof settings.pauseUntil === "string" &&
    settings.pauseUntil.length > 0 &&
    Date.parse(settings.pauseUntil) > now.getTime()
  );
}

function isAllowedBySiteAccess(
  tab: RememberedTab,
  settings: BrowserBridgeSettings,
): boolean {
  if (tab.incognito && !settings.incognitoEnabled) {
    return false;
  }
  const origin = tabOrigin(tab);
  if (!origin) {
    return false;
  }
  const blockedOrigins = new Set(settings.blockedOrigins.map(normalizeOrigin));
  if (blockedOrigins.has(origin)) {
    return false;
  }
  switch (settings.siteAccessMode) {
    case "current_site_only":
      return tab.focusedActive;
    case "granted_sites": {
      const grantedOrigins = new Set(
        settings.grantedOrigins.map(normalizeOrigin),
      );
      return grantedOrigins.has(origin);
    }
    default:
      return true;
  }
}

export function mergeRememberedTabs(
  previous: readonly RememberedTab[],
  snapshot: readonly RememberedTab[],
  maxRememberedTabs: number,
): RememberedTab[] {
  const byKey = new Map(previous.map((tab) => [identityKey(tab), tab]));
  for (const tab of snapshot) {
    const key = identityKey(tab);
    const prior = byKey.get(key);
    byKey.set(key, {
      ...tab,
      lastFocusedAt:
        tab.lastFocusedAt ??
        prior?.lastFocusedAt ??
        (tab.focusedActive || tab.activeInWindow ? tab.lastSeenAt : null),
    });
  }
  const openKeys = new Set(snapshot.map((tab) => identityKey(tab)));
  const merged = [...byKey.values()].map((tab) => {
    if (openKeys.has(identityKey(tab))) {
      return tab;
    }
    return {
      ...tab,
      activeInWindow: false,
      focusedWindow: false,
      focusedActive: false,
    };
  });
  return sortTabs(merged).slice(0, Math.max(1, maxRememberedTabs));
}

export function findFocusedTab(
  tabs: readonly RememberedTab[],
): RememberedTab | null {
  return (
    tabs.find((tab) => tab.focusedActive) ??
    tabs.find((tab) => tab.activeInWindow) ??
    tabs[0] ??
    null
  );
}

export function selectTabsForSync(args: {
  previous: readonly RememberedTab[];
  snapshot: readonly RememberedTab[];
  settings: BrowserBridgeSettings | null;
  fallbackMaxRememberedTabs: number;
  now?: Date;
}): RememberedTab[] {
  const {
    previous,
    snapshot,
    settings,
    fallbackMaxRememberedTabs,
    now = new Date(),
  } = args;
  if (
    !settings?.enabled ||
    settings.trackingMode === "off" ||
    isTrackingPaused(settings, now)
  ) {
    return [];
  }

  const filteredPrevious = previous.filter((tab) =>
    isAllowedBySiteAccess(tab, settings),
  );
  const filteredSnapshot = snapshot.filter((tab) =>
    isAllowedBySiteAccess(tab, settings),
  );

  if (settings.trackingMode === "current_tab") {
    const focused = findFocusedTab(filteredSnapshot);
    return focused ? [focused] : [];
  }

  const maxRememberedTabs =
    Number.isFinite(settings.maxRememberedTabs) &&
    settings.maxRememberedTabs > 0
      ? settings.maxRememberedTabs
      : fallbackMaxRememberedTabs;
  return mergeRememberedTabs(
    filteredPrevious,
    filteredSnapshot,
    maxRememberedTabs,
  );
}
