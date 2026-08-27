/**
 * Connector package-name ↔ connector-key reverse-lookup map consumed by
 * host-app code (plugins-routes.ts uses it to sync UI config).
 * `CONNECTOR_PLUGINS` is sourced from the generated first-party
 * channel-plugin-map.json.
 *
 * The configured-detection helpers (isConnectorConfigured, isWechatConfigured)
 * live in @elizaos/core and are re-exported here for back-compat with callers
 * that still import them from @elizaos/shared. Per-plugin auto-enable itself
 * lives in ./plugin-manifest.ts (each plugin declares conditions via
 * package.json's `elizaos.plugin.autoEnableModule`).
 */
import channelPluginMap from "@elizaos/registry/first-party/channel-plugin-map.json" with {
  type: "json",
};

export { isConnectorConfigured, isWechatConfigured } from "@elizaos/core/edge";

export const CONNECTOR_PLUGINS: Record<string, string> = channelPluginMap;
