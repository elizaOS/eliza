import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

const PLACEHOLDER_TEXT = "(ainex not connected)";

export const robotStateProvider: Provider = {
  name: "AINEX_ROBOT_STATE",
  description:
    "Current robot pose, joint angles, IMU, and walk-controller state from the AiNex bridge.",
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
