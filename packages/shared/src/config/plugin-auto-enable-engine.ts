// Connector / streaming configuration helpers.
//
// Auto-enable used to live here as a centralized engine that walked
// hard-coded maps (CONNECTOR_PLUGINS, AUTH_PROVIDER_PLUGINS, FEATURE_PLUGINS,
// etc.) and decided which plugins to enable. That model is gone — every
// plugin now declares its own enable conditions via
// `package.json.elizaos.plugin.autoEnableModule`, evaluated by the engine in
// ./plugin-manifest.ts. See plugin-resolver in @elizaos/agent for the call
// site.
//
// What survives in this file:
//   - CONNECTOR_PLUGINS / STREAMING_PLUGINS — reverse-lookup maps used by
//     plugins-compat-routes.ts to translate "@elizaos/plugin-x" ↔ connector
//     keys for UI config sync. Not for auto-enable.
//   - isConnectorConfigured / isStreamingDestinationConfigured — shared
//     "is this connector/destination block actually configured?" helpers
//     that several per-plugin auto-enable.ts files import to keep their
//     predicates terse. Pure data inspection, no agent dependencies.

import { isWechatConfigured } from "./wechat-config";

export const CONNECTOR_PLUGINS: Record<string, string> = {
  bluebubbles: "@elizaos/plugin-bluebubbles",
  telegram: "@elizaos/plugin-telegram",
  discord: "@elizaos/plugin-discord",
  discordLocal: "@elizaos/plugin-discord-local",
  slack: "@elizaos/plugin-slack",
  x: "@elizaos/plugin-x",
  // Backward-compat alias: legacy "twitter" connector key resolves to plugin-x.
  twitter: "@elizaos/plugin-x",
  whatsapp: "@elizaos/plugin-whatsapp",
  signal: "@elizaos/plugin-signal",
  imessage: "@elizaos/plugin-imessage",
  farcaster: "@elizaos/plugin-farcaster",
  lens: "@elizaos/plugin-lens",
  msteams: "@elizaos/plugin-msteams",
  feishu: "@elizaos/plugin-feishu",
  matrix: "@elizaos/plugin-matrix",
  nostr: "@elizaos/plugin-nostr",
  blooio: "@elizaos/plugin-blooio",
  twitch: "@elizaos/plugin-twitch",
  mattermost: "@elizaos/plugin-mattermost",
  googlechat: "@elizaos/plugin-google-chat",
  wechat: "elizaoswechat",
};

export const STREAMING_PLUGINS: Record<string, string> = {
  twitch: "@elizaos/plugin-streaming",
  youtube: "@elizaos/plugin-streaming",
  customRtmp: "@elizaos/plugin-streaming",
  pumpfun: "@elizaos/plugin-streaming",
  x: "@elizaos/plugin-streaming",
  rtmpSources: "@elizaos/plugin-streaming",
};

export function isConnectorConfigured(
  connectorName: string,
  connectorConfig: unknown,
): boolean {
  if (!connectorConfig || typeof connectorConfig !== "object") {
    return false;
  }
  const config = connectorConfig as Record<string, unknown>;
  if (config.enabled === false) {
    return false;
  }
  if (config.botToken || config.token || config.apiKey) {
    return true;
  }

  const hasEnabledSignalAccount =
    connectorName === "signal" &&
    typeof config.accounts === "object" &&
    config.accounts !== null &&
    Object.values(config.accounts as Record<string, unknown>).some(
      (account) => {
        if (!account || typeof account !== "object") return false;
        const accountConfig = account as Record<string, unknown>;
        if (accountConfig.enabled === false) return false;
        return Boolean(
          accountConfig.authDir ||
            accountConfig.account ||
            accountConfig.httpUrl ||
            accountConfig.httpHost ||
            accountConfig.httpPort ||
            accountConfig.cliPath,
        );
      },
    );

  if (hasEnabledSignalAccount) {
    return true;
  }

  switch (connectorName) {
    case "bluebubbles":
      return Boolean(config.serverUrl && config.password);
    case "discordLocal":
      return Boolean(config.clientId && config.clientSecret);
    case "imessage":
      return Boolean(
        config.enabled === true || config.cliPath || config.dbPath,
      );
    case "signal":
      return Boolean(
        config.authDir ||
          config.account ||
          config.httpUrl ||
          config.httpHost ||
          config.httpPort ||
          config.cliPath,
      );
    case "whatsapp":
      // authState/sessionPath: legacy field names
      // authDir: Baileys multi-file auth state directory (WhatsAppAccountSchema)
      // accounts: at least one account with authDir set and not explicitly disabled
      return Boolean(
        config.authState ||
          config.sessionPath ||
          config.authDir ||
          (config.accounts &&
            typeof config.accounts === "object" &&
            Object.values(config.accounts as Record<string, unknown>).some(
              (account) => {
                if (!account || typeof account !== "object") return false;
                const acc = account as Record<string, unknown>;
                if (acc.enabled === false) return false;
                return Boolean(acc.authDir);
              },
            )),
      );
    case "twitch":
      return Boolean(
        config.accessToken || config.clientId || config.enabled === true,
      );
    case "wechat":
      // wechat may be configured with a top-level apiKey (caught by the
      // generic check above) OR a multi-account map. Delegate to the
      // dedicated helper for the multi-account case.
      return isWechatConfigured(config);
    default:
      return false;
  }
}

export function isStreamingDestinationConfigured(
  destName: string,
  destConfig: unknown,
): boolean {
  if (!destConfig || typeof destConfig !== "object") return false;
  const config = destConfig as Record<string, unknown>;
  if (config.enabled === false) return false;

  switch (destName) {
    case "twitch":
      return Boolean(config.streamKey || config.enabled === true);
    case "youtube":
      return Boolean(config.streamKey || config.enabled === true);
    case "customRtmp":
      return Boolean(config.rtmpUrl && config.rtmpKey);
    case "pumpfun":
      return Boolean(config.streamKey && config.rtmpUrl);
    case "x":
      return Boolean(config.streamKey && config.rtmpUrl);
    case "rtmpSources":
      return (
        Array.isArray(destConfig) &&
        destConfig.some((row) => {
          if (!row || typeof row !== "object") return false;
          const rec = row as Record<string, unknown>;
          const id = String(rec.id ?? "").trim();
          const url = String(rec.rtmpUrl ?? "").trim();
          const key = String(rec.rtmpKey ?? "").trim();
          return Boolean(id && url && key);
        })
      );
    default:
      return false;
  }
}
