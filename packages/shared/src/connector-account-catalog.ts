/**
 * Shared catalog of per-connector account defaults
 * (`defaultRole` / `defaultPurpose` / `supportsOAuth`) for the plugin-managed
 * account inventory (#12087 Item 10, arch-audit roles-permissions).
 *
 * The audit's sanctioned pattern is "owner-declared, runtime-enforced": the
 * metadata that governs a connector account's default role / purpose / OAuth
 * capability belongs to the connector's declaration, not duplicated as literals
 * in the UI. This module is that single declaration site.
 *
 * It lives in `@elizaos/shared` — the package both the agent server and the UI
 * already depend on — so it can be the one catalog both consult. Today the
 * connector setup UI (`packages/ui/src/components/connectors/
 * connector-account-options.ts`) reads role / purpose / OAuth from here when
 * rendering plugin-managed account options. The server connector-account layer
 * (`@elizaos/core` connectors, `packages/agent/src/api/connector-*-routes.ts`)
 * is the intended next consumer so these defaults project from one place rather
 * than being re-declared; it does not import this catalog yet.
 *
 * The UI previously hardcoded these three fields per connector in its own map
 * (the `@deprecated CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS` literal). That
 * copy is now removed: the UI reads role / purpose / OAuth from this catalog and
 * only owns its presentation strings (label / title / description). A grep guard
 * test (`connector-account-catalog.test.ts`) asserts the authorization-relevant
 * defaults exist only here.
 *
 * IMPORTANT: this module is dependency-free (pure data + pure functions) so it
 * imports safely into the browser UI bundle without pulling `@elizaos/core`.
 * The role/purpose string unions are declared structurally here and are kept
 * in lockstep with `@elizaos/core`'s `ConnectorAccountRole` /
 * `ConnectorAccountPurpose` (see `packages/core/src/types/
 * connector-account-policy.ts`).
 */

/**
 * Canonical connector account role. Mirrors `ConnectorAccountRole` in
 * `@elizaos/core` (`types/connector-account-policy.ts`) — kept structural here
 * to avoid a core import in the UI bundle.
 */
export type ConnectorAccountCatalogRole = "OWNER" | "AGENT" | "TEAM";

/**
 * Canonical connector account purpose. A structural superset-safe subset of
 * `ConnectorAccountPurpose` in `@elizaos/core`; the concrete values used by the
 * plugin-managed catalog below are all members of that union.
 */
export type ConnectorAccountCatalogPurpose =
  | "messaging"
  | "posting"
  | "reading"
  | "calendar"
  | "drive"
  | "meet"
  | "contacts";

/** Provider-owned OAuth capability rendered by the generic account UI. */
export interface ConnectorOAuthCapabilityDeclaration {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Per-connector account defaults. This is the authoritative declaration the
 * server owns and the UI reads. Presentation-only fields (labels/descriptions)
 * are intentionally NOT here — those stay in the UI layer.
 */
export interface ConnectorAccountCatalogEntry {
  /**
   * Canonical connector id used by the account-manager provider registry and
   * the plugin-managed account panels (e.g. "telegram", "x", "google").
   */
  readonly connectorId: string;
  /**
   * Provider id passed to the account inventory API. Currently always equal to
   * `connectorId` for the plugin-managed set, but kept distinct to match the
   * provider/connector split the account routes already use.
   */
  readonly provider: string;
  /** Default role assigned to a newly-created account for this connector. */
  readonly defaultRole: ConnectorAccountCatalogRole;
  /** Default purpose set for a newly-created account for this connector. */
  readonly defaultPurpose: readonly ConnectorAccountCatalogPurpose[];
  /** Whether this connector's accounts are provisioned via an OAuth flow. */
  readonly supportsOAuth: boolean;
  /** Explicit least-privilege choices required when starting OAuth. */
  readonly oauthCapabilities?: readonly ConnectorOAuthCapabilityDeclaration[];
  /**
   * Alternate ids that normalize onto this connector (e.g. "twitter" → "x",
   * "gmail" → "google"). Used for catalog lookup only.
   */
  readonly aliases?: readonly string[];
}

/**
 * The plugin-managed connector account catalog: the single source of truth for
 * `defaultRole` / `defaultPurpose` / `supportsOAuth`.
 *
 * Values here MUST match the historical UI literals exactly — this is a
 * refactor of where the truth lives, not a behavior change. See the
 * per-connector default table in the PR for the before/after proof.
 */
export const CONNECTOR_ACCOUNT_CATALOG: readonly ConnectorAccountCatalogEntry[] =
  [
    {
      connectorId: "telegram",
      provider: "telegram",
      defaultRole: "AGENT",
      defaultPurpose: ["messaging"],
      supportsOAuth: false,
    },
    {
      connectorId: "google",
      provider: "google",
      defaultRole: "OWNER",
      defaultPurpose: ["messaging", "calendar", "drive", "meet", "contacts"],
      supportsOAuth: true,
      oauthCapabilities: [
        {
          id: "gmail.read",
          group: "Gmail",
          label: "Read Gmail",
          description: "Search and read Gmail messages.",
        },
        {
          id: "gmail.compose",
          group: "Gmail",
          label: "Draft Gmail",
          description: "Create and update Gmail drafts without sending them.",
        },
        {
          id: "gmail.send",
          group: "Gmail",
          label: "Send Gmail",
          description: "Send email through Gmail.",
        },
        {
          id: "gmail.manage",
          group: "Gmail",
          label: "Manage Gmail",
          description: "Modify Gmail labels, message state, and settings.",
        },
        {
          id: "calendar.read",
          group: "Calendar",
          label: "Read Calendar",
          description: "List Google Calendar events.",
        },
        {
          id: "calendar.write",
          group: "Calendar",
          label: "Write Calendar",
          description: "Create and update Google Calendar events.",
        },
        {
          id: "drive.read",
          group: "Drive",
          label: "Read Drive",
          description: "Search and read Google Drive file metadata.",
        },
        {
          id: "drive.write",
          group: "Drive",
          label: "Write Drive",
          description: "Create or update files opened by this integration.",
        },
        {
          id: "meet.create",
          group: "Meet",
          label: "Create Meet Spaces",
          description: "Create Google Meet spaces.",
        },
        {
          id: "meet.read",
          group: "Meet",
          label: "Read Meet Artifacts",
          description: "Read Meet spaces, participants, and artifacts.",
        },
        {
          id: "people.read",
          group: "People",
          label: "Read Contacts",
          description: "Search and read Google Contacts and Other Contacts.",
        },
      ],
      aliases: ["gmail", "google-workspace"],
    },
    {
      connectorId: "x",
      provider: "x",
      defaultRole: "OWNER",
      defaultPurpose: ["posting", "reading", "messaging"],
      supportsOAuth: true,
      aliases: ["twitter"],
    },
    {
      connectorId: "slack",
      provider: "slack",
      defaultRole: "OWNER",
      defaultPurpose: ["messaging", "posting", "reading"],
      supportsOAuth: true,
    },
    {
      connectorId: "whatsapp",
      provider: "whatsapp",
      defaultRole: "AGENT",
      defaultPurpose: ["messaging"],
      supportsOAuth: false,
    },
  ];

const CONNECTOR_ACCOUNT_CATALOG_BY_ID: ReadonlyMap<
  string,
  ConnectorAccountCatalogEntry
> = new Map(
  CONNECTOR_ACCOUNT_CATALOG.flatMap((entry) => [
    [entry.connectorId, entry] as const,
    [entry.provider, entry] as const,
    ...(entry.aliases ?? []).map((alias) => [alias, entry] as const),
  ]),
);

/**
 * Normalizes a raw connector id to its catalog key: lowercases, strips the
 * `@elizaos/plugin-` / `plugin-` prefixes, and folds the "twitter" alias onto
 * the canonical "x" id. Kept in lockstep with the UI's
 * `normalizeConnectorCatalogId` (the UI re-exports this).
 */
export function normalizeConnectorCatalogId(connectorId: string): string {
  const normalized = connectorId
    .trim()
    .toLowerCase()
    .replace(/^@elizaos\/plugin-/, "")
    .replace(/^plugin-/, "");
  return normalized === "twitter" ? "x" : normalized;
}

/**
 * Resolves a connector id (canonical, provider, or alias form) to its catalog
 * entry, or `null` when the connector is not plugin-managed.
 */
export function getConnectorAccountCatalogEntry(
  connectorId: string | undefined | null,
): ConnectorAccountCatalogEntry | null {
  if (!connectorId) return null;
  return (
    CONNECTOR_ACCOUNT_CATALOG_BY_ID.get(
      normalizeConnectorCatalogId(connectorId),
    ) ?? null
  );
}

/** Whether the given connector id has a plugin-managed account catalog entry. */
export function hasConnectorAccountCatalogEntry(
  connectorId: string | undefined | null,
): boolean {
  return getConnectorAccountCatalogEntry(connectorId) !== null;
}
