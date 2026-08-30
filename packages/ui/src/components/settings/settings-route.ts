/**
 * Structured Settings hash routes. Most sections are flat (`#appearance`);
 * Connectors alone nests a detail segment (`#connectors/discord`) so index and
 * per-connector config pages share one section registration without inventing
 * a second settings section per connector.
 *
 * Section-id validity against the live registry is applied by callers (see
 * `readSettingsHashSection` in settings-sections.ts) so this module stays free
 * of a circular import with the section registry.
 */

/** Flat section, or Connectors index / connector detail. */
export type SettingsRoute =
  | { kind: "hub" }
  | { kind: "section"; sectionId: string }
  | { kind: "connector-detail"; sectionId: "connectors"; connectorId: string };

const CONNECTOR_DETAIL_HISTORY_KEY = "elizaSettingsConnectorDetail";

const SETTINGS_HASH_ALIASES: Readonly<Record<string, string>> = {
  general: "appearance",
  cloud: "ai-model",
  providers: "ai-model",
  billing: "cloud-billing",
  "api-keys": "cloud-api-keys",
  // Legacy aliases that still appear in bookmarks / deep links.
  twitter: "x",
};

/** Canonicalize a connector id segment (trim, lower-case, alias map). */
export function normalizeConnectorRouteId(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return trimmed;
  return SETTINGS_HASH_ALIASES[trimmed] ?? trimmed;
}

/**
 * Parse a raw location hash (with or without leading `#`) into a settings
 * route. Does not consult the section registry — callers drop unknown section
 * ids. Nested paths under non-connectors sections collapse to that section.
 */
export function parseSettingsHash(rawHash: string): SettingsRoute {
  const withoutHash = rawHash.replace(/^#/, "").trim();
  if (!withoutHash) return { kind: "hub" };

  const segments = withoutHash.split("/").filter(Boolean);
  const [rawHead, rawConnectorId] = segments;
  if (!rawHead) return { kind: "hub" };

  const head = SETTINGS_HASH_ALIASES[rawHead] ?? rawHead;

  if (segments.length === 1) {
    return { kind: "section", sectionId: head };
  }

  // Only connectors may nest: #connectors/<connectorId>
  if (head === "connectors" && rawConnectorId) {
    const connectorId = normalizeConnectorRouteId(rawConnectorId);
    if (!connectorId) {
      return { kind: "section", sectionId: "connectors" };
    }
    return {
      kind: "connector-detail",
      sectionId: "connectors",
      connectorId,
    };
  }

  // Nested path under a non-connectors section — keep the section, drop the rest.
  return { kind: "section", sectionId: head };
}

export function readSettingsHashRoute(): SettingsRoute {
  if (typeof window === "undefined") return { kind: "hub" };
  return parseSettingsHash(window.location.hash);
}

/** Section id only — back-compat for callers that ignore connector detail. */
export function readSettingsHashSectionId(): string | null {
  const route = readSettingsHashRoute();
  if (route.kind === "hub") return null;
  return route.sectionId;
}

export function settingsRouteToHash(route: SettingsRoute): string {
  if (route.kind === "hub") return "#";
  if (route.kind === "section") return `#${route.sectionId}`;
  return `#connectors/${normalizeConnectorRouteId(route.connectorId)}`;
}

/**
 * Write the settings hash without pushing history. `replaceState` does not
 * fire `hashchange`, so callers must update their own React state in the same
 * turn (or listen to `popstate` only for true history walks).
 */
export function replaceSettingsHashRoute(route: SettingsRoute): void {
  if (typeof window === "undefined") return;
  const nextHash = settingsRouteToHash(route);
  const current = window.location.hash || "#";
  if (
    current === nextHash ||
    (nextHash === "#" && (current === "" || current === "#"))
  ) {
    return;
  }
  if (nextHash === "#") {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    return;
  }
  window.history.replaceState(null, "", nextHash);
}

export function openConnectorsIndexHash(): void {
  replaceSettingsHashRoute({ kind: "section", sectionId: "connectors" });
}

function connectorDetailRoute(connectorId: string): SettingsRoute | null {
  const id = normalizeConnectorRouteId(connectorId);
  if (!id) return null;
  return {
    kind: "connector-detail",
    sectionId: "connectors",
    connectorId: id,
  };
}

/** User navigation creates a real history entry so browser/hardware Back works. */
export function openConnectorDetailHash(connectorId: string): void {
  if (typeof window === "undefined") return;
  const route = connectorDetailRoute(connectorId);
  if (!route) {
    openConnectorsIndexHash();
    return;
  }
  const nextHash = settingsRouteToHash(route);
  if (window.location.hash === nextHash) return;
  const currentState =
    window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {};
  window.history.pushState(
    { ...currentState, [CONNECTOR_DETAIL_HISTORY_KEY]: true },
    "",
    nextHash,
  );
}

/**
 * Programmatic focus/deep links canonicalize without polluting history.
 * When the current entry is already a user-pushed connector detail, preserve
 * the detail marker so detail→detail focus swaps keep a single consumable
 * history entry (visible Back still returns to the index; the next hardware
 * Back leaves connectors entirely).
 */
export function replaceConnectorDetailHash(connectorId: string): void {
  if (typeof window === "undefined") return;
  const route = connectorDetailRoute(connectorId);
  if (!route) {
    openConnectorsIndexHash();
    return;
  }
  const nextHash = settingsRouteToHash(route);
  const currentHash = window.location.hash || "#";
  if (currentHash === nextHash) return;

  const currentRoute = parseSettingsHash(currentHash);
  if (
    currentRoute.kind === "connector-detail" &&
    isPushedConnectorDetailRoute()
  ) {
    const currentState =
      window.history.state && typeof window.history.state === "object"
        ? window.history.state
        : {};
    window.history.replaceState(
      { ...currentState, [CONNECTOR_DETAIL_HISTORY_KEY]: true },
      "",
      nextHash,
    );
    return;
  }

  replaceSettingsHashRoute(route);
}

export function isPushedConnectorDetailRoute(): boolean {
  return Boolean(window.history.state?.[CONNECTOR_DETAIL_HISTORY_KEY]);
}

/**
 * Visible Back consumes a user-pushed detail entry. Direct/programmatic detail
 * routes have no marker, so they safely canonicalize to the connectors index.
 */
export function backFromConnectorDetail(): void {
  if (typeof window === "undefined") return;
  if (isPushedConnectorDetailRoute()) {
    window.history.back();
    return;
  }
  openConnectorsIndexHash();
  window.dispatchEvent(new Event("popstate"));
}
