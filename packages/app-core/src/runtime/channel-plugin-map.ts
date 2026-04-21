import { CHANNEL_PLUGIN_MAP as upstreamChannelPluginMap } from "@elizaos/agent/runtime/plugin-collector";

const INTERNAL_CHANNEL_PLUGIN_OVERRIDES = {
  signal: "@elizaos/plugin-signal",
  whatsapp: "@elizaos/plugin-whatsapp",
  wechat: "elizaoswechat",
} as const;

export const CHANNEL_PLUGIN_MAP = {
  ...upstreamChannelPluginMap,
  ...INTERNAL_CHANNEL_PLUGIN_OVERRIDES,
};
