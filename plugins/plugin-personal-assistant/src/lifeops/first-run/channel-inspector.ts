/**
 * Registry-backed channel inspector for first-run notification validation.
 * The first-run question parser owns the fallback behavior, while this module
 * adapts the runtime's channel and connector registries into the inspector
 * contract installed by the plugin composition root.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { ChannelRegistry } from "../channels/index.js";
import { getConnectorRegistry } from "../connectors/registry.js";
import { setRuntimeChannelInspector } from "./questions.js";

export function installFirstRunChannelInspector(
  runtime: IAgentRuntime,
  channelRegistry: ChannelRegistry,
): void {
  setRuntimeChannelInspector(runtime, {
    isRegistered(channel) {
      return channelRegistry.get(channel) !== null;
    },
    async isConnected(channel) {
      if (channel === "in_app") {
        return true;
      }
      const contribution = channelRegistry.get(channel);
      const connectorKind = contribution?.connectorKind ?? channel;
      if (!connectorKind) {
        return false;
      }
      const connector = getConnectorRegistry(runtime)?.get(connectorKind);
      if (!connector) {
        return false;
      }
      const status = await connector.status();
      return status.state === "ok";
    },
  });
}
