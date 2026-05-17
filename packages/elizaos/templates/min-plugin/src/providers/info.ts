import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

const PLUGIN_NAME = "__PLUGIN_NAME__";

export const infoProvider: Provider = {
  name: "__PLUGIN_NAME___INFO",
  description: `Static info provider for the ${PLUGIN_NAME} plugin.`,
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ) => {
    const text = `[${PLUGIN_NAME}] active`;
    return { text, values: { pluginName: PLUGIN_NAME }, data: {} };
  },
};
