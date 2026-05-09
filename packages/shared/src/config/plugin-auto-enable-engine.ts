// Connector / streaming reverse-lookup maps consumed by host-app code.
//
// The connector/streaming detection helpers (isConnectorConfigured,
// isStreamingDestinationConfigured, isWechatConfigured) live in
// @elizaos/core now — re-exported below for back-compat with callers that
// still import from @elizaos/shared. The reverse-lookup maps stay here
// since they're app-side data (consumed by plugins-compat-routes.ts to
// translate package names ↔ connector keys for UI config sync).
//
// Plugin auto-enable is in ./plugin-manifest.ts. Each plugin declares its
// own enable conditions via package.json's `elizaos.plugin.autoEnableModule`.

export {
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  isWechatConfigured,
} from "@elizaos/core";

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
