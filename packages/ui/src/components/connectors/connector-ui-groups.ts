/**
 * Client-side Connectors index grouping. Explicit catalog (not id heuristics):
 * every first-party connector is assigned a group; unknowns fall through to
 * Other. When the plugins API gains `connectorSubtype`, replace this map with
 * the wire field — until then the index still matches the Devin-style grouped
 * list without inventing groups from name substrings.
 */

export type ConnectorUiGroupId = "messaging" | "social" | "other";

export interface ConnectorUiGroupMeta {
  id: ConnectorUiGroupId;
  label: string;
  description: string;
  order: number;
}

export const CONNECTOR_UI_GROUPS: readonly ConnectorUiGroupMeta[] = [
  {
    id: "messaging",
    label: "Messaging",
    description: "Chat apps the agent can use in this mode",
    order: 0,
  },
  {
    id: "social",
    label: "Social",
    description: "Public networks and feeds",
    order: 1,
  },
  {
    id: "other",
    label: "Other",
    description: "Additional connectors",
    order: 2,
  },
] as const;

const GROUP_BY_ID: Readonly<Record<string, ConnectorUiGroupId>> = {
  discord: "messaging",
  telegram: "messaging",
  whatsapp: "messaging",
  imessage: "messaging",
  blooio: "messaging",
  slack: "messaging",
  msteams: "messaging",
  mattermost: "messaging",
  "google-chat": "messaging",
  matrix: "messaging",
  feishu: "messaging",
  line: "messaging",
  zalo: "messaging",
  zalouser: "messaging",
  tlon: "messaging",
  "nextcloud-talk": "messaging",
  x: "social",
  twitter: "social",
  instagram: "social",
  farcaster: "social",
  bluesky: "social",
  nostr: "social",
  twitch: "social",
  google: "other",
};

export function getConnectorUiGroupId(connectorId: string): ConnectorUiGroupId {
  const key = connectorId.trim().toLowerCase();
  return GROUP_BY_ID[key] ?? "other";
}

export function connectorStatusLabel(
  plugin: {
    enabled: boolean;
    configured: boolean;
    validationErrors: readonly unknown[];
    loadError?: string | null;
    isActive?: boolean;
  },
  t: (key: string, opts?: { defaultValue?: string }) => string,
): { label: string; tone: "ok" | "warn" | "muted" | "danger" } {
  if (plugin.loadError) {
    return {
      label: t("connectors.status.loadFailed", {
        defaultValue: "Load failed",
      }),
      tone: "danger",
    };
  }
  if (!plugin.enabled) {
    return {
      label: t("connectors.status.disabled", { defaultValue: "Disabled" }),
      tone: "muted",
    };
  }
  if (plugin.validationErrors.length > 0 || !plugin.configured) {
    return {
      label: t("connectors.status.needsSetup", {
        defaultValue: "Needs setup",
      }),
      tone: "warn",
    };
  }
  if (plugin.enabled && plugin.isActive === false) {
    return {
      label: t("connectors.status.enabledInactive", {
        defaultValue: "Enabled",
      }),
      tone: "warn",
    };
  }
  return {
    label: t("connectors.status.enabled", { defaultValue: "Enabled" }),
    tone: "ok",
  };
}
