import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "shell";

export const shellPlugin: Plugin = {
  name: pluginName,
  description: "Shell plugin (browser stub; not supported in browsers)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(`[plugin-${pluginName}] This plugin is not supported in browsers.`);
  },
};

export default shellPlugin;
