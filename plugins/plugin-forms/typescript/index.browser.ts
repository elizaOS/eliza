import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "@elizaos/plugin-forms";

export const formsPlugin: Plugin = {
  name: pluginName,
  description: "Forms plugin (browser stub; use a server proxy)",
  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default formsPlugin;

