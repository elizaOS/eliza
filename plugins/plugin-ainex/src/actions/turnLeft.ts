import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getNumberOption, startWalking } from "./_helpers";

export const turnLeftAction: Action = {
  name: "AINEX_TURN_LEFT",
  similes: ["TURN_LEFT", "ROTATE_LEFT", "SPIN_LEFT"],
  description:
    "Turn the AiNex robot in place to its left (positive yaw). Fire-and-forget — robot keeps turning until AINEX_STOP.",
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
        y: 0,
        yaw: Math.abs(getNumberOption(options, "yaw", 8)),
        speed: getNumberOption(options, "speed", 2),
        height: getNumberOption(options, "height", 0.036),
      },
      "AiNex is turning left.",
      "turn left",
    );
  },
};
