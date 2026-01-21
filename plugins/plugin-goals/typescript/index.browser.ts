import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "goals";

export const goalsPlugin: Plugin = {
  name: pluginName,
  description: "Goals plugin (browser stub; use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default goalsPlugin;
