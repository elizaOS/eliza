import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "@elizaos/plugin-trajectory-logger";

export const trajectoryLoggerPlugin: Plugin = {
  name: pluginName,
  description: "Trajectory logger plugin (browser stub; use a server proxy)",
  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default trajectoryLoggerPlugin;
