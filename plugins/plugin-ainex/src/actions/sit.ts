import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { sendOne } from "./_helpers";

export const sitAction: Action = {
  name: "AINEX_SIT",
  similes: ["SIT", "SIT_DOWN", "CROUCH"],
  description: "Play the `sit` action group — moves the AiNex into a seated pose.",
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
      { name: "sit" },
      "AiNex is sitting down.",
      "sit",
    );
  },
};
