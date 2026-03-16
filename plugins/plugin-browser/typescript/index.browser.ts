import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "plugin-browser";

export const browserPlugin: Plugin = {
  name: pluginName,
  description: "Browser plugin (browser stub; not implemented in this package yet)",
  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] Browser stub loaded. This package does not currently ship a browser implementation.`
    );
  },
};

export default browserPlugin;

