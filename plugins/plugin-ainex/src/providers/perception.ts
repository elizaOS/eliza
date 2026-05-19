import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

const PLACEHOLDER_TEXT = "(ainex not connected)";

export const perceptionProvider: Provider = {
  name: "AINEX_PERCEPTION",
  description:
    "Robot-side perception summary (camera frame metadata, detected objects, target hand-off to plugin-vision).",
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
