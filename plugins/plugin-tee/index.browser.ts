/**
 * Browser-unavailable stand-in for `teePlugin`: TEE attestation requires a
 * server-side dstack SDK connection, so this entry only warns and does not
 * wire up services/providers. Not referenced by package `exports` — the
 * plugin is Node-only per `registry-entry.json`.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "tee";

export const teePlugin: Plugin = {
  name: pluginName,
  description: "TEE plugin (browser-unavailable entry; use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`,
    );
  },
};

export default teePlugin;
