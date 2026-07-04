// Connector / streaming reverse-lookup maps consumed by host-app code.
//
// The connector/streaming detection helpers (isConnectorConfigured,
// isStreamingDestinationConfigured, isWechatConfigured) live in
// @elizaos/core now — re-exported below for back-compat with callers that
// still import from @elizaos/shared. The reverse-lookup maps stay here
// since they're app-side data (consumed by plugins-routes.ts to
// translate package names ↔ connector keys for UI config sync).
//
// Plugin auto-enable is in ./plugin-manifest.ts. Each plugin declares its
// own enable conditions via package.json's `elizaos.plugin.autoEnableModule`.
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
