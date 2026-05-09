// CYCLE BREAK: previously imported `CHANNEL_PLUGIN_MAP` from
// `@elizaos/agent`, creating an `agent ↔ app-core` ESM cycle that
// surfaced as `ReferenceError: Cannot access 'upstreamChannelPluginMap'
// before initialization` at bench-server boot. Inline the canonical
// list (mirror of `packages/agent/src/runtime/plugin-collector.ts`'s
// CHANNEL_PLUGIN_MAP) plus the three app-local overrides. Keep in sync
// with that file when channels are added or renamed.
const _upstreamChannelPluginMap: Readonly<Record<string, string>> = {
  bluebubbles: "@elizaos/plugin-bluebubbles",
  discord: "@elizaos/plugin-discord",
  discordLocal: "@elizaos/plugin-discord-local",
  telegram: "@elizaos/plugin-telegram",
  slack: "@elizaos/plugin-slack",
  x: "@elizaos/plugin-x",
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
};

const INTERNAL_CHANNEL_PLUGIN_OVERRIDES = {
  signal: "@elizaos/plugin-signal",
  whatsapp: "@elizaos/plugin-whatsapp",
  wechat: "elizaoswechat",
} as const;

export const CHANNEL_PLUGIN_MAP = {
  ..._upstreamChannelPluginMap,
  ...INTERNAL_CHANNEL_PLUGIN_OVERRIDES,
};
