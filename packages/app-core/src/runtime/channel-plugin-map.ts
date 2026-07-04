/**
 * Exposes CHANNEL_PLUGIN_MAP: the channel-name → plugin-package lookup used to
 * resolve which connector plugin owns a given channel. The map is derived at
 * registry build time from each connector entry's `channels` (see
 * packages/registry/src/first-party) and statically imported here as JSON, so
 * `@elizaos/agent` and `@elizaos/app-core` share one generated artifact with no
 * cross-import and no hand-maintained duplication — eliminating the former
 * `agent ↔ app-core` ESM cycle.
 */
import channelPluginMap from "@elizaos/registry/first-party/channel-plugin-map.json" with {
  type: "json",
};

export const CHANNEL_PLUGIN_MAP: Readonly<Record<string, string>> =
  channelPluginMap;
