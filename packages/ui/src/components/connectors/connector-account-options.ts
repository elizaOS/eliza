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

export const CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS: readonly ConnectorPluginManagedAccountOption[] =
  [
    {
      value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: "telegram",
      provider: "telegram",
      label: "Plugin-managed",
      title: "Telegram accounts",
      description:
        "Manage Telegram bot accounts through @elizaos/plugin-telegram account inventory.",
      defaultRole: "AGENT",
      defaultPurpose: ["messaging"],
      supportsOAuth: false,
    },
    {
      value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: "signal",
      provider: "signal",
      label: "Plugin-managed",
      title: "Signal accounts",
      description:
        "Manage Signal account records and device pairing through @elizaos/plugin-signal.",
      defaultRole: "OWNER",
      defaultPurpose: ["messaging"],
      supportsOAuth: false,
    },
    {
      value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: "google",
      provider: "google",
      label: "Plugin-managed",
      title: "Google accounts",
      description:
        "Manage Google Workspace accounts through @elizaos/plugin-google OAuth account inventory.",
      defaultRole: "OWNER",
      defaultPurpose: ["messaging", "calendar", "drive", "meet"],
      supportsOAuth: true,
      aliases: ["gmail", "google-workspace"],
    },
    {
      value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: "x",
      provider: "x",
      label: "Plugin-managed",
      title: "X accounts",
      description:
        "Manage X/Twitter accounts through @elizaos/plugin-x account inventory.",
      defaultRole: "OWNER",
      defaultPurpose: ["posting", "reading", "messaging"],
      supportsOAuth: true,
      aliases: ["twitter"],
    },
    {
      value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: "slack",
      provider: "slack",
      label: "Plugin-managed",
      title: "Slack accounts",
      description:
        "Manage Slack workspace accounts through @elizaos/plugin-slack OAuth account inventory.",
      defaultRole: "OWNER",
      defaultPurpose: ["messaging", "posting", "reading"],
      supportsOAuth: true,
    },
    {
      value: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      connectorId: "whatsapp",
      provider: "whatsapp",
      label: "Plugin-managed",
      title: "WhatsApp accounts",
      description:
        "Manage WhatsApp account records through @elizaos/plugin-whatsapp account inventory.",
      defaultRole: "AGENT",
      defaultPurpose: ["messaging"],
      supportsOAuth: false,
    },
  ];

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

export function normalizeConnectorCatalogId(connectorId: string): string {
  const normalized = connectorId
    .trim()
    .toLowerCase()
    .replace(/^@elizaos\/plugin-/, "")
    .replace(/^plugin-/, "");
  return normalized === "twitter" ? "x" : normalized;
}

export function getConnectorPluginManagedAccountOption(
  connectorId: string | undefined,
): ConnectorPluginManagedAccountOption | null {
  if (!connectorId) return null;
  return (
    CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS_BY_ID.get(
      normalizeConnectorCatalogId(connectorId),
    ) ?? null
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
