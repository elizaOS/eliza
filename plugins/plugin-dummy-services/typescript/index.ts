import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";

/**
 * A tiny "dummy services" plugin used by tests/examples that expect
 * some services to exist without requiring real external integrations.
 */
export const plugin: Plugin = {
  name: "@elizaos/plugin-dummy-services",
  description: "Test-only dummy services for elizaOS",
  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.debug({ src: "plugin:dummy-services" }, "Dummy services initialized");
  },
};

export default plugin;

