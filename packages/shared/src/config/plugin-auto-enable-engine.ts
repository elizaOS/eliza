/**
 * Connector / streaming package-name ↔ connector-key reverse-lookup maps
 * consumed by host-app code (plugins-routes.ts uses them to sync UI config).
 * `CONNECTOR_PLUGINS` is sourced from the generated first-party
 * channel-plugin-map.json; `STREAMING_PLUGINS` is the streaming equivalent.
 *
 * The configured-detection helpers (isConnectorConfigured,
 * isStreamingDestinationConfigured, isWechatConfigured) now live in
 * @elizaos/core and are re-exported here for back-compat with callers that
 * still import them from @elizaos/shared. Per-plugin auto-enable itself lives in
 * ./plugin-manifest.ts (each plugin declares conditions via package.json's
 * `elizaos.plugin.autoEnableModule`).
 */
import channelPluginMap from "@elizaos/registry/first-party/channel-plugin-map.json" with {
  type: "json",
};

export {
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  isWechatConfigured,
} from "@elizaos/core";

export const CONNECTOR_PLUGINS: Record<string, string> = channelPluginMap;

export const STREAMING_PLUGINS: Record<string, string> = {
  twitch: "@elizaos/plugin-streaming",
  youtube: "@elizaos/plugin-streaming",
  customRtmp: "@elizaos/plugin-streaming",
  pumpfun: "@elizaos/plugin-streaming",
  x: "@elizaos/plugin-streaming",
  rtmpSources: "@elizaos/plugin-streaming",
};
