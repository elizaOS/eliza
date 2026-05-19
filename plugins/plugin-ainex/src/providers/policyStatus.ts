import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

const PLACEHOLDER_TEXT = "(ainex not connected)";

export const policyStatusProvider: Provider = {
  name: "AINEX_POLICY_STATUS",
  description:
    "Active learned-policy / VLA / RL skill lifecycle status reported by the bridge.",
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
