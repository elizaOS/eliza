/**
 * Browser build stub for plugin-shell: exports a no-op Plugin whose init() warns
 * that shell execution is unsupported in browsers. Selected in place of index.ts
 * for the browser bundle target.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "shell";

export const shellPlugin: Plugin = {
  name: pluginName,
  description: "Shell plugin (unsupported browser export)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(`[plugin-${pluginName}] This plugin is not supported in browsers.`);
  },
};

export default shellPlugin;
