import { useEffect, useState } from "react";
import { useApp } from "../../state";

export type ConnectorMode = {
  id: string;
  label: string;
  description: string;
};

/**
 * Returns available modes for each connector based on deployment context.
 */
export function getConnectorModes(
  connectorId: string,
  options?: { elizaCloudConnected?: boolean },
): ConnectorMode[] {
  const cloud = options?.elizaCloudConnected ?? false;

  switch (connectorId) {
    case "discord":
      return [
        ...(cloud
          ? [
              {
                id: "managed",
                label: "OAuth Gateway",
                description:
                  "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app.",
              },
            ]
          : []),
        {
          id: "local",
          label: "Desktop App",
          description: "Connect via local Discord desktop app (IPC)",
        },
        {
          id: "bot",
          label: "Bot Token",
          description:
            "Use your own Discord bot with a token from the Developer Portal",
        },
      ];

    case "telegram":
      return [
        ...(cloud
          ? [
              {
                id: "cloud-bot",
                label: "Cloud Gateway",
                description:
                  "Telegram bot communication still starts with a BotFather token; Eliza Cloud can host the webhook and route it to this app.",
              },
            ]
          : []),
        {
          id: "bot",
          label: "Bot Token",
          description: "Create a bot via @BotFather and paste the token",
        },
        {
          id: "account",
          label: "Personal Account",
          description:
            "Use your own Telegram account (requires app credentials from my.telegram.org)",
        },
      ];

    case "slack":
      return [
        ...(cloud
          ? [
              {
                id: "oauth",
                label: "OAuth",
                description:
                  "Connect Slack through Eliza Cloud OAuth for workspace-scoped bidirectional access.",
              },
            ]
          : []),
        {
          id: "socket",
          label: "Socket Mode Tokens",
          description:
            "Use your own Slack app token and bot token for the local connector runtime.",
        },
      ];

    case "twitter":
      return [
        ...(cloud
          ? [
              {
                id: "oauth",
                label: "OAuth",
                description:
                  "Connect X/Twitter through Eliza Cloud OAuth so the agent can post, read mentions, and handle DMs through cloud-held tokens.",
              },
            ]
          : []),
        {
          id: "local-oauth",
          label: "Local OAuth2",
          description:
            "Use @elizaos/plugin-twitter with TWITTER_AUTH_MODE=oauth, a client ID, and a loopback redirect URI.",
        },
        {
          id: "developer",
          label: "Developer Tokens",
          description:
            "Use OAuth 1.0a API keys and access tokens from the X Developer Portal.",
        },
      ];

    case "signal":
      return [
        {
          id: "qr",
          label: "QR Pair",
          description: "Link as a device to your Signal account via QR code",
        },
      ];

    case "whatsapp":
      return [
        {
          id: "qr",
          label: "QR Pair",
          description: "Scan a QR code from your WhatsApp mobile app",
        },
        {
          id: "business",
          label: "Business Cloud API",
          description:
            "Use WhatsApp Business API with access token and phone number ID",
        },
      ];

    case "imessage":
      return [
        {
          id: "direct",
          label: "Direct (chat.db)",
          description:
            "Read iMessage database directly on this Mac. Requires Full Disk Access.",
        },
        {
          id: "bluebubbles",
          label: "BlueBubbles",
          description:
            "Bridge via BlueBubbles server app. Works locally or over network.",
        },
        ...(cloud
          ? [
              {
                id: "blooio",
                label: "Blooio (Cloud)",
                description:
                  "Cloud-based iMessage/SMS gateway. No Mac needed on the server.",
              },
            ]
          : []),
      ];

    default:
      return [];
  }
}

/**
 * Maps connector mode to the plugin ID that ConnectorSetupPanel renders.
 */
export function modeToSetupPluginId(
  connectorId: string,
  modeId: string,
): string | null {
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
    signal: { qr: "signal" },
    whatsapp: { qr: "whatsapp", business: "whatsapp" },
    imessage: {
      direct: "imessage",
      bluebubbles: "bluebubbles",
      blooio: "blooio",
    },
  };
  return map[connectorId]?.[modeId] ?? null;
}

export function getDefaultConnectorModeId(
  connectorId: string,
  modes: ConnectorMode[],
): string {
  const preferredDefaults: Record<string, string[]> = {
    discord: ["bot"],
    slack: ["oauth", "socket"],
    telegram: ["bot"],
    twitter: ["oauth", "local-oauth"],
  };
  for (const preferred of preferredDefaults[connectorId] ?? []) {
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
            className={`rounded-xl border px-3 py-1.5 text-xs-tight font-medium transition-all ${
              selectedMode === mode.id
                ? "border-accent bg-accent/10 text-accent"
                : "border-border/40 bg-card/40 text-muted hover:border-accent/40 hover:text-txt"
            }`}
            title={mode.description}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {modes.find((m) => m.id === selectedMode)?.description && (
        <div className="mt-1.5 text-2xs text-muted">
          {modes.find((m) => m.id === selectedMode)?.description}
        </div>
      )}
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
