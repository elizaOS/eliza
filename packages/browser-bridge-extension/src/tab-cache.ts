/**
 * Tab bookkeeping for the background sync loop: merges freshly queried tabs
 * into the remembered set, ranks them by focus then recency, and selects the
 * subset to sync according to the tracking mode (current tab vs active tabs).
 * Pure functions over RememberedTab — no browser API calls.
 */
import type { BrowserBridgeSettings } from "./browser-bridge-contracts";
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
    const leftAnchor = Date.parse(left.lastFocusedAt ?? left.lastSeenAt ?? "");
    const rightAnchor = Date.parse(
      right.lastFocusedAt ?? right.lastSeenAt ?? "",
    );
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

function normalizeBlockedHost(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return null;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//.test(candidate)
        ? candidate
        : `https://${candidate.replace(/^\*\./, "")}`,
    );
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase().replace(/\.+$/, "") || null;
  } catch {
    // error-policy:J3 Invalid block entries cannot match a tab.
    return null;
  }
}

function tabOrigin(tab: Pick<RememberedTab, "url">): string | null {
  try {
    return normalizeOrigin(new URL(tab.url).origin);
  } catch {
    // error-policy:J3 Invalid tab URLs have no shareable origin.
    return null;
  }
}

export function urlMatchesGrantedOrigins(
  url: string,
  grantedOrigins: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 Invalid target URLs never match a browser grant.
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return grantedOrigins.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();
    if (pattern === "<all_urls>" || pattern === "*://*/*") {
      return true;
    }
    const match = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(pattern);
    if (!match) {
      return false;
    }
    const [, scheme, hostPattern] = match;
    if (scheme !== "*" && `${scheme}:` !== parsed.protocol) {
      return false;
    }
    if (hostPattern === "*") {
      return true;
    }
    if (hostPattern.startsWith("*.")) {
      const domain = hostPattern.slice(2);
      return hostname === domain || hostname.endsWith(`.${domain}`);
    }
    return hostname === hostPattern;
  });
}

/**
 * Applies the host-scoped block policy shown by the app: a stored host or URL
 * blocks that host and its subdomains regardless of scheme or port.
 */
export function urlMatchesBlockedOrigins(
  url: string,
  blockedOrigins: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 Invalid target URLs never match a block entry.
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  return blockedOrigins.some((entry) => {
    const blockedHost = normalizeBlockedHost(entry);
    return (
      blockedHost !== null &&
      (hostname === blockedHost || hostname.endsWith(`.${blockedHost}`))
    );
  });
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
  grantedOrigins: readonly string[],
): boolean {
  if (tab.incognito && !settings.incognitoEnabled) {
    return false;
  }
  const origin = tabOrigin(tab);
  if (!origin) {
    return false;
  }
  if (!urlMatchesGrantedOrigins(tab.url, grantedOrigins)) {
    return false;
  }
  if (urlMatchesBlockedOrigins(tab.url, settings.blockedOrigins)) {
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
  grantedOrigins: readonly string[];
  now?: Date;
}): RememberedTab[] {
  const {
    previous,
    snapshot,
    settings,
    fallbackMaxRememberedTabs,
    grantedOrigins,
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
    isAllowedBySiteAccess(tab, settings, grantedOrigins),
  );
  const filteredSnapshot = snapshot.filter((tab) =>
    isAllowedBySiteAccess(tab, settings, grantedOrigins),
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
