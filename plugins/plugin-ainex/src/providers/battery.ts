import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

const PLACEHOLDER_TEXT = "(ainex not connected)";

export const batteryProvider: Provider = {
  name: "AINEX_BATTERY",
  description: "Robot battery voltage and charge state from the AiNex bridge.",
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => ({
    text: PLACEHOLDER_TEXT,
    values: { ainexConnected: false },
    data: {},
  }),
};
