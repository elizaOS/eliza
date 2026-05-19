import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { sendOne } from "./_helpers";

export const standAction: Action = {
  name: "AINEX_STAND",
  similes: ["STAND", "STAND_UP", "GET_UP"],
  description:
    "Play the `stand` action group — moves the AiNex into its calibrated home pose.",
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
      { name: "stand" },
      "AiNex is standing.",
      "stand",
    );
  },
};
