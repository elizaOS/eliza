/**
 * Canonical connector-id lists and config-schema constants — the authoritative
 * `CONNECTOR_IDS` set (core connectors plus extensions) that config validation
 * and connector-enumeration code across the stack reference.
 */
const ELIZA_CORE_CONNECTOR_IDS = [
  "bluebubbles",
  "telegram",
  "telegramAccount",
  "discord",
  "discordLocal",
  "slack",
  "twitter",
  "whatsapp",
  "signal",
  "imessage",
  "farcaster",
  "lens",
  "msteams",
  "feishu",
  "matrix",
  "nostr",
  "blooio",
  "twitch",
  "mattermost",
  "googlechat",
] as const;

/** App-local connectors that still participate in config schema generation. */
export const ELIZA_LOCAL_CONNECTOR_IDS = ["wechat"] as const;

export const CONNECTOR_IDS = [
  ...ELIZA_CORE_CONNECTOR_IDS,
  ...ELIZA_LOCAL_CONNECTOR_IDS,
] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];
