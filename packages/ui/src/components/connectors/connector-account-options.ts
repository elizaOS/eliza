/**
 * Catalog and confirmation rules for connector-account attributes: the privacy
 * levels, purposes/roles, and plugin-managed mode metadata rendered by the
 * account selectors, plus the single source of truth for when a privacy
 * escalation or owner-role promotion requires typed/explicit confirmation.
 *
 * Per-connector account defaults (`defaultRole` / `defaultPurpose` /
 * `supportsOAuth`) are NOT declared here. They live in the server-authoritative
 * `CONNECTOR_ACCOUNT_CATALOG` in `@elizaos/shared` (#12087 Item 10, arch-audit
 * roles-permissions); this module reads them from that catalog and only owns
 * the connector's presentation strings.
 */

import {
  CONNECTOR_ACCOUNT_CATALOG,
  type ConnectorAccountCatalogEntry,
  type ConnectorOAuthCapabilityDeclaration,
  getConnectorAccountCatalogEntry,
  normalizeConnectorCatalogId as normalizeConnectorCatalogIdShared,
} from "@elizaos/shared/connector-account-catalog";

import type {
  ConnectorAccountCreateInput,
  ConnectorAccountPrivacy,
  ConnectorAccountPurpose,
  ConnectorAccountRole,
} from "../../api/client-agent";

export interface ConnectorAccountOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export type ConnectorPrivacyConfirmationRequirement =
  | "none"
  | "typed"
  | "public";

export type ConnectorRoleConfirmationRequirement = "none" | "owner";

export const CONNECTOR_PLUGIN_MANAGED_MODE_ID = "plugin-managed";
export const CONNECTOR_ACCOUNT_MANAGEMENT_PANEL_PREFIX =
  "connector-account-management";

export type ConnectorManagementMode =
  | typeof CONNECTOR_PLUGIN_MANAGED_MODE_ID
  | "cloud-managed"
  | "local-setup"
  | "local-config";

export interface ConnectorPluginManagedAccountOption
  extends ConnectorAccountOption<typeof CONNECTOR_PLUGIN_MANAGED_MODE_ID> {
  connectorId: string;
  provider: string;
  title: string;
  defaultRole: ConnectorAccountRole;
  defaultPurpose: readonly ConnectorAccountPurpose[];
  supportsOAuth: boolean;
  oauthCapabilities?: readonly ConnectorOAuthCapabilityDeclaration[];
  aliases?: readonly string[];
}

export const CONNECTOR_ACCOUNT_PURPOSE_OPTIONS: readonly ConnectorAccountOption<ConnectorAccountRole>[] =
  [
    {
      value: "OWNER",
      label: "OWNER",
      description: "Use the human owner's identity for this connector.",
    },
    {
      value: "AGENT",
      label: "AGENT",
      description: "Let the agent act through this account.",
    },
    {
      value: "TEAM",
      label: "TEAM",
      description: "Use a shared team identity.",
    },
  ];

export const CONNECTOR_ACCOUNT_PRIVACY_OPTIONS: readonly ConnectorAccountOption<ConnectorAccountPrivacy>[] =
  [
    {
      value: "owner_only",
      label: "Owner only",
      description: "Visible only to the owner. This is the default.",
    },
    {
      value: "team_visible",
      label: "Team visible",
      description: "Team members can see this account is connected.",
    },
    {
      value: "semi_public",
      label: "Semi-public",
      description: "Visible in limited shared connector surfaces.",
    },
    {
      value: "public",
      label: "Public",
      description: "Visible anywhere this connector exposes public identity.",
    },
  ];

export const CONNECTOR_PRIVACY_TYPED_CONFIRMATION = "SHARE";
export const CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION = "PUBLIC";
export const CONNECTOR_OWNER_ROLE_CONFIRMATION = "OWNER";

/**
 * UI presentation strings (title/description) for each plugin-managed
 * connector, keyed by canonical connector id. This is the ONLY connector
 * metadata the UI still owns — it is purely cosmetic.
 *
 * The authorization-relevant defaults (`defaultRole` / `defaultPurpose` /
 * `supportsOAuth`) are NOT here: they live in the server-authoritative
 * `CONNECTOR_ACCOUNT_CATALOG` in `@elizaos/shared` (#12087 Item 10). This UI
 * map used to hardcode those three fields too; they were removed so the truth
 * lives in one place. `connector-account-catalog.test.ts` grep-guards that the
 * literals do not reappear here.
 */
const CONNECTOR_PLUGIN_MANAGED_PRESENTATION: Readonly<
  Record<string, { title: string; description: string }>
> = {
  telegram: {
    title: "Telegram accounts",
    description:
      "Manage Telegram bot accounts through @elizaos/plugin-telegram account inventory.",
  },
  google: {
    title: "Google accounts",
    description:
      "Manage Google Workspace accounts through @elizaos/plugin-google-workspace OAuth account inventory.",
  },
  x: {
    title: "X accounts",
    description:
      "Manage X/Twitter accounts through @elizaos/plugin-x account inventory.",
  },
  slack: {
    title: "Slack accounts",
    description:
      "Manage Slack workspace accounts through @elizaos/plugin-slack OAuth account inventory.",
  },
  whatsapp: {
    title: "WhatsApp accounts",
    description:
      "Manage WhatsApp account records through @elizaos/plugin-whatsapp account inventory.",
  },
};

/**
 * Projects a server-catalog entry (`@elizaos/shared`) plus the UI's own
 * presentation strings into the `ConnectorPluginManagedAccountOption` shape the
 * account selectors render. `defaultRole` / `defaultPurpose` / `supportsOAuth`
 * come straight from the catalog — the UI does not re-declare them.
 */
function toPluginManagedAccountOption(
  entry: ConnectorAccountCatalogEntry,
): ConnectorPluginManagedAccountOption {
  const presentation = CONNECTOR_PLUGIN_MANAGED_PRESENTATION[entry.connectorId];
  return {
    value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
    connectorId: entry.connectorId,
    provider: entry.provider,
    label: "Plugin-managed",
    title: presentation?.title ?? `${entry.connectorId} accounts`,
    description:
      presentation?.description ??
      `Manage ${entry.connectorId} accounts through its connector plugin.`,
    defaultRole: entry.defaultRole,
    defaultPurpose: entry.defaultPurpose,
    supportsOAuth: entry.supportsOAuth,
    ...(entry.oauthCapabilities
      ? { oauthCapabilities: entry.oauthCapabilities }
      : {}),
    ...(entry.aliases ? { aliases: entry.aliases } : {}),
  };
}

/**
 * Plugin-managed connector account options, projected from the
 * server-authoritative {@link CONNECTOR_ACCOUNT_CATALOG}. The UI reads its
 * role/purpose/OAuth defaults from the shared catalog; only the presentation
 * strings are UI-owned (#12087 Item 10).
 */
export const CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS: readonly ConnectorPluginManagedAccountOption[] =
  CONNECTOR_ACCOUNT_CATALOG.map(toPluginManagedAccountOption);

const CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS_BY_ID = new Map(
  CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS.flatMap((option) => [
    [option.connectorId, option],
    [option.provider, option],
    ...(option.aliases ?? []).map((alias) => [alias, option] as const),
  ]),
);

const CONNECTOR_PRIVACY_RANK: Record<ConnectorAccountPrivacy, number> = {
  owner_only: 0,
  team_visible: 1,
  semi_public: 2,
  public: 3,
};

/**
 * Re-exported from `@elizaos/shared` so the UI and server normalize connector
 * ids identically (single source of truth). Kept as a named export for the
 * existing UI consumers that import it from this module.
 */
export const normalizeConnectorCatalogId = normalizeConnectorCatalogIdShared;

export function getConnectorPluginManagedAccountOption(
  connectorId: string | undefined,
): ConnectorPluginManagedAccountOption | null {
  if (!connectorId) return null;
  // Resolve through the shared catalog first; the local by-id map (built from
  // the same catalog) provides the projected UI option.
  const entry = getConnectorAccountCatalogEntry(connectorId);
  if (!entry) return null;
  return (
    CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS_BY_ID.get(entry.connectorId) ??
    null
  );
}

export function hasConnectorPluginManagedAccounts(
  connectorId: string | undefined,
): boolean {
  return getConnectorPluginManagedAccountOption(connectorId) !== null;
}

export function connectorAccountManagementPanelPluginId(
  connectorId: string,
): string | null {
  const option = getConnectorPluginManagedAccountOption(connectorId);
  if (!option) return null;
  return `${CONNECTOR_ACCOUNT_MANAGEMENT_PANEL_PREFIX}:${option.provider}:${option.connectorId}`;
}

export function parseConnectorAccountManagementPanelPluginId(
  pluginId: string,
): { provider: string; connectorId: string } | null {
  const [prefix, provider, connectorId] = pluginId.split(":");
  if (prefix !== CONNECTOR_ACCOUNT_MANAGEMENT_PANEL_PREFIX || !provider) {
    return null;
  }
  return {
    provider,
    connectorId: connectorId || provider,
  };
}

export function getConnectorPluginManagedAccountCreateInput(
  connectorId: string,
): ConnectorAccountCreateInput | undefined {
  const option = getConnectorPluginManagedAccountOption(connectorId);
  if (!option || option.supportsOAuth) return undefined;
  return {
    label: `New ${option.title.replace(/\s+accounts$/i, "")} account`,
    role: option.defaultRole,
    purpose: [...option.defaultPurpose],
    privacy: "owner_only",
    metadata: {
      managementMode: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: option.connectorId,
      provider: option.provider,
    },
  };
}

export function getConnectorPurposeOption(
  value: ConnectorAccountRole | undefined,
): ConnectorAccountOption<ConnectorAccountRole> {
  return (
    CONNECTOR_ACCOUNT_PURPOSE_OPTIONS.find(
      (option) => option.value === value,
    ) ?? CONNECTOR_ACCOUNT_PURPOSE_OPTIONS[0]
  );
}

export function getConnectorPrivacyOption(
  value: ConnectorAccountPrivacy | undefined,
): ConnectorAccountOption<ConnectorAccountPrivacy> {
  return (
    CONNECTOR_ACCOUNT_PRIVACY_OPTIONS.find(
      (option) => option.value === value,
    ) ?? CONNECTOR_ACCOUNT_PRIVACY_OPTIONS[0]
  );
}

export function getConnectorPrivacyConfirmationRequirement(
  current: ConnectorAccountPrivacy | undefined,
  next: ConnectorAccountPrivacy,
): ConnectorPrivacyConfirmationRequirement {
  const resolvedCurrent = current ?? "owner_only";
  if (next === resolvedCurrent) return "none";
  if (next === "public" && resolvedCurrent !== "public") return "public";
  if (CONNECTOR_PRIVACY_RANK[next] > CONNECTOR_PRIVACY_RANK[resolvedCurrent]) {
    return "typed";
  }
  return "none";
}

export function isConnectorPrivacyConfirmationSatisfied(
  requirement: ConnectorPrivacyConfirmationRequirement,
  typedValue: string,
  publicAcknowledged: boolean,
): boolean {
  const normalized = typedValue.trim().toUpperCase();
  if (requirement === "none") return true;
  if (requirement === "typed") {
    return normalized === CONNECTOR_PRIVACY_TYPED_CONFIRMATION;
  }
  return (
    normalized === CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION && publicAcknowledged
  );
}

export function getConnectorRoleConfirmationRequirement(
  current: ConnectorAccountRole | undefined,
  next: ConnectorAccountRole,
): ConnectorRoleConfirmationRequirement {
  return next === "OWNER" && (current ?? "OWNER") !== "OWNER"
    ? "owner"
    : "none";
}

export function isConnectorRoleConfirmationSatisfied(
  requirement: ConnectorRoleConfirmationRequirement,
  typedValue: string,
): boolean {
  if (requirement === "none") return true;
  return typedValue.trim().toUpperCase() === CONNECTOR_OWNER_ROLE_CONFIRMATION;
}
