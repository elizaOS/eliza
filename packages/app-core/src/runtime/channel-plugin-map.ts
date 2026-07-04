// The channel -> plugin-package map is derived at registry build time from each
// connector entry's `channels` (see packages/registry/src/first-party). This was
// previously a hand-maintained mirror of `@elizaos/agent`'s CHANNEL_PLUGIN_MAP
// (kept in sync manually to avoid an `agent ↔ app-core` ESM cycle). Both now
// statically import the same generated artifact, so the duplication and the
// cycle are gone — neither package imports the other for this map.
import channelPluginMap from "@elizaos/registry/first-party/channel-plugin-map.json" with {
  type: "json",
};

export const CHANNEL_PLUGIN_MAP: Readonly<Record<string, string>> =
  channelPluginMap;
