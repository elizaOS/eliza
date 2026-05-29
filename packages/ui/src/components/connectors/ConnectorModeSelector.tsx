import { useEffect, useState } from "react";
import { useApp } from "../../state";
import {
  CONNECTOR_PLUGIN_MANAGED_MODE_ID,
  type ConnectorManagementMode,
  connectorAccountManagementPanelPluginId,
  getConnectorPluginManagedAccountOption,
  normalizeConnectorCatalogId,
} from "./connector-account-options";

export type ConnectorMode = {
  id: string;
  label: string;
  description: string;
  labelKey?: string;
  descriptionKey?: string;
  managementMode?: ConnectorManagementMode;
};

function withPluginManagedMode(
  connectorId: string,
  modes: ConnectorMode[],
): ConnectorMode[] {
  const option = getConnectorPluginManagedAccountOption(connectorId);
  if (!option) return modes;
  return [
    {
      id: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      label: option.label,
      description: option.description,
      managementMode: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
    },
    ...modes.filter((mode) => mode.id !== CONNECTOR_PLUGIN_MANAGED_MODE_ID),
  ];
}

/**
 * Returns available modes for each connector based on deployment context.
 */
export function getConnectorModes(
  connectorId: string,
  options?: { elizaCloudConnected?: boolean },
): ConnectorMode[] {
  const cloud = options?.elizaCloudConnected ?? false;
  const normalizedConnectorId = normalizeConnectorCatalogId(connectorId);

  switch (normalizedConnectorId) {
    case "discord":
      return withPluginManagedMode(connectorId, [
        ...(cloud
          ? [
              {
                id: "managed",
                label: "OAuth Gateway",
                labelKey: "connectormode.discord.managed.label",
                description:
                  "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app.",
                descriptionKey: "connectormode.discord.managed.description",
                managementMode: "cloud-managed" as const,
              },
            ]
          : []),
        {
          id: "local",
          label: "Desktop App",
          labelKey: "connectormode.discord.local.label",
          description: "Connect via local Discord desktop app (IPC)",
          descriptionKey: "connectormode.discord.local.description",
          managementMode: "local-setup",
        },
        {
          id: "bot",
          label: "Bot Token",
          labelKey: "connectormode.discord.bot.label",
          description:
            "Use your own Discord bot with a token from the Developer Portal",
          descriptionKey: "connectormode.discord.bot.description",
          managementMode: "local-config",
        },
      ]);

    case "telegram":
      return withPluginManagedMode(connectorId, [
        ...(cloud
          ? [
              {
                id: "cloud-bot",
                label: "Cloud Gateway",
                labelKey: "connectormode.telegram.cloudBot.label",
                description:
                  "Telegram bot communication still starts with a BotFather token; Eliza Cloud can host the webhook and route it to this app.",
                descriptionKey: "connectormode.telegram.cloudBot.description",
                managementMode: "cloud-managed" as const,
              },
            ]
          : []),
        {
          id: "bot",
          label: "Bot Token",
          labelKey: "connectormode.telegram.bot.label",
          description: "Create a bot via @BotFather and paste the token",
          descriptionKey: "connectormode.telegram.bot.description",
          managementMode: "local-config",
        },
        {
          id: "account",
          label: "Personal Account",
          labelKey: "connectormode.telegram.account.label",
          description:
            "Use your own Telegram account (requires app credentials from my.telegram.org)",
          descriptionKey: "connectormode.telegram.account.description",
          managementMode: "local-setup",
        },
      ]);

    case "slack":
      return withPluginManagedMode(connectorId, [
        ...(cloud
          ? [
              {
                id: "oauth",
                label: "OAuth",
                labelKey: "connectormode.slack.oauth.label",
                description:
                  "Connect Slack through Eliza Cloud OAuth for workspace-scoped bidirectional access.",
                descriptionKey: "connectormode.slack.oauth.description",
                managementMode: "cloud-managed" as const,
              },
            ]
          : []),
        {
          id: "socket",
          label: "Socket Mode Tokens",
          labelKey: "connectormode.slack.socket.label",
          description:
            "Use your own Slack app token and bot token for the local connector runtime.",
          descriptionKey: "connectormode.slack.socket.description",
          managementMode: "local-config",
        },
      ]);

    case "x":
    case "twitter":
      return withPluginManagedMode(connectorId, [
        ...(cloud
          ? [
              {
                id: "oauth",
                label: "OAuth",
                labelKey: "connectormode.x.oauth.label",
                description:
                  "Connect X/Twitter through Eliza Cloud OAuth so the agent can post, read mentions, and handle DMs through cloud-held tokens.",
                descriptionKey: "connectormode.x.oauth.description",
                managementMode: "cloud-managed" as const,
              },
            ]
          : []),
        {
          id: "local-oauth",
          label: "Local OAuth2",
          labelKey: "connectormode.x.localOauth.label",
          description:
            "Use @elizaos/plugin-x with TWITTER_AUTH_MODE=oauth, a client ID, and a loopback redirect URI.",
          descriptionKey: "connectormode.x.localOauth.description",
          managementMode: "local-config",
        },
        {
          id: "developer",
          label: "Developer Tokens",
          labelKey: "connectormode.x.developer.label",
          description:
            "Use OAuth 1.0a API keys and access tokens from the X Developer Portal.",
          descriptionKey: "connectormode.x.developer.description",
          managementMode: "local-config",
        },
      ]);

    case "signal":
      return withPluginManagedMode(connectorId, [
        {
          id: "qr",
          label: "QR Pair",
          labelKey: "connectormode.signal.qr.label",
          description: "Link as a device to your Signal account via QR code",
          descriptionKey: "connectormode.signal.qr.description",
          managementMode: "local-setup",
        },
      ]);

    case "whatsapp":
      return withPluginManagedMode(connectorId, [
        {
          id: "qr",
          label: "QR Pair",
          labelKey: "connectormode.whatsapp.qr.label",
          description: "Scan a QR code from your WhatsApp mobile app",
          descriptionKey: "connectormode.whatsapp.qr.description",
          managementMode: "local-setup",
        },
        {
          id: "business",
          label: "Business Cloud API",
          labelKey: "connectormode.whatsapp.business.label",
          description:
            "Use WhatsApp Business API with access token and phone number ID",
          descriptionKey: "connectormode.whatsapp.business.description",
          managementMode: "local-config",
        },
      ]);

    case "imessage":
      return [
        {
          id: "direct",
          label: "Direct (chat.db)",
          labelKey: "connectormode.imessage.direct.label",
          description:
            "Read iMessage database directly on this Mac. Requires Full Disk Access.",
          descriptionKey: "connectormode.imessage.direct.description",
          managementMode: "local-setup",
        },
        {
          id: "bluebubbles",
          label: "BlueBubbles",
          labelKey: "connectormode.imessage.bluebubbles.label",
          description:
            "Bridge via BlueBubbles server app. Works locally or over network.",
          descriptionKey: "connectormode.imessage.bluebubbles.description",
          managementMode: "local-config",
        },
        ...(cloud
          ? [
              {
                id: "blooio",
                label: "Blooio (Cloud)",
                labelKey: "connectormode.imessage.blooio.label",
                description:
                  "Cloud-based iMessage/SMS gateway. No Mac needed on the server.",
                descriptionKey: "connectormode.imessage.blooio.description",
                managementMode: "cloud-managed" as const,
              },
            ]
          : []),
      ];

    default:
      return withPluginManagedMode(connectorId, []);
  }
}

/**
 * Maps connector mode to the plugin ID that ConnectorSetupPanel renders.
 */
export function modeToSetupPluginId(
  connectorId: string,
  modeId: string,
): string | null {
  if (modeId === CONNECTOR_PLUGIN_MANAGED_MODE_ID) {
    return connectorAccountManagementPanelPluginId(connectorId);
  }
  const map: Record<string, Record<string, string>> = {
    discord: { local: "discordlocal", bot: "discord", managed: "discord" },
    telegram: {
      "cloud-bot": "telegram",
      bot: "telegram",
      account: "telegramaccount",
    },
    slack: { oauth: "slack", socket: "slack" },
    twitter: {
      oauth: "twitter",
      "local-oauth": "twitter",
      developer: "twitter",
    },
    x: {
      oauth: "x",
      "local-oauth": "x",
      developer: "x",
    },
    signal: { qr: "signal" },
    whatsapp: { qr: "whatsapp", business: "whatsapp" },
    imessage: {
      direct: "imessage",
      bluebubbles: "bluebubbles",
      blooio: "blooio",
    },
  };
  return map[normalizeConnectorCatalogId(connectorId)]?.[modeId] ?? null;
}

export function getDefaultConnectorModeId(
  connectorId: string,
  modes: ConnectorMode[],
): string {
  if (modes.some((mode) => mode.id === CONNECTOR_PLUGIN_MANAGED_MODE_ID)) {
    return CONNECTOR_PLUGIN_MANAGED_MODE_ID;
  }
  const preferredDefaults: Record<string, string[]> = {
    discord: ["bot"],
    slack: ["oauth", "socket"],
    telegram: ["bot"],
    x: ["oauth", "local-oauth"],
    twitter: ["oauth", "local-oauth"],
  };
  for (const preferred of preferredDefaults[
    normalizeConnectorCatalogId(connectorId)
  ] ?? []) {
    if (modes.some((mode) => mode.id === preferred)) {
      return preferred;
    }
  }
  return modes[0]?.id ?? "";
}

export function ConnectorModeSelector({
  connectorId,
  selectedMode,
  onModeChange,
  elizaCloudConnected,
}: {
  connectorId: string;
  selectedMode: string;
  onModeChange: (modeId: string) => void;
  elizaCloudConnected?: boolean;
}) {
  const { t } = useApp();
  const modes = getConnectorModes(connectorId, { elizaCloudConnected });

  if (modes.length <= 1) return null;

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold text-muted">
        {t("pluginsview.ConnectionMode", {
          defaultValue: "Connection mode",
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            data-testid={`connector-mode-${connectorId}-${mode.id}`}
            onClick={() => onModeChange(mode.id)}
            className={`rounded-sm border px-3 py-1.5 text-xs-tight font-medium transition-all ${
              selectedMode === mode.id
                ? "border-accent bg-accent/10 text-accent"
                : "border-border/40 bg-card/40 text-muted hover:border-accent/40 hover:text-txt"
            }`}
            title={
              mode.descriptionKey
                ? t(mode.descriptionKey, { defaultValue: mode.description })
                : mode.description
            }
          >
            {mode.labelKey
              ? t(mode.labelKey, { defaultValue: mode.label })
              : mode.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Hook to manage connector mode state. Reads initial mode from config
 * or defaults to the first available mode.
 */
export function useConnectorMode(
  connectorId: string,
  options?: { elizaCloudConnected?: boolean },
) {
  const modes = getConnectorModes(connectorId, options);
  const defaultMode = getDefaultConnectorModeId(connectorId, modes);
  const [selectedMode, setSelectedMode] = useState(defaultMode);

  useEffect(() => {
    if (!modes.some((mode) => mode.id === selectedMode)) {
      setSelectedMode(defaultMode);
    }
  }, [defaultMode, modes, selectedMode]);

  return {
    modes,
    selectedMode,
    setSelectedMode,
    setupPluginId: modeToSetupPluginId(connectorId, selectedMode),
  };
}
