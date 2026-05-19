import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getNumberOption, startWalking } from "./_helpers";

export const sideStepLeftAction: Action = {
  name: "AINEX_SIDE_STEP_LEFT",
  similes: ["SIDE_STEP_LEFT", "STRAFE_LEFT", "SHUFFLE_LEFT"],
  description:
    "Strafe the AiNex robot to its left. Fire-and-forget — robot walks until AINEX_STOP.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    return startWalking(
      runtime,
      callback,
      {
        x: 0,
        y: getNumberOption(options, "y", 0.03),
        yaw: 0,
        speed: getNumberOption(options, "speed", 2),
        height: getNumberOption(options, "height", 0.036),
      },
      "AiNex is side-stepping left.",
      "side-step left",
    );
  },
};
