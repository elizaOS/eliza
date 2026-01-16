import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "@elizaos/plugin-n8n";

export const n8nPlugin: Plugin = {
  name: pluginName,
  description: "n8n plugin (browser stub; use a server proxy)",
  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default n8nPlugin;
