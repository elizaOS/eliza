import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { sendOne } from "./_helpers";

export const bowAction: Action = {
  name: "AINEX_BOW",
  similes: ["BOW", "TAKE_A_BOW"],
  description: "Play the `bow` action group on the AiNex robot.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    return sendOne(
      runtime,
      callback,
      "action.play",
      { name: "bow" },
      "AiNex is bowing.",
      "bow",
    );
  },
};
