import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getNumberOption, startWalking } from "./_helpers";

export const walkBackwardAction: Action = {
  name: "AINEX_WALK_BACKWARD",
  similes: ["WALK_BACKWARD", "MOVE_BACKWARD", "GO_BACK", "BACK_UP"],
  description:
    "Start walking the AiNex robot backward. Sends walk.set+walk.command:start to the bridge; robot keeps walking until AINEX_STOP. Options: speed (1-4).",
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
        x: getNumberOption(options, "x", -0.03),
        y: 0,
        yaw: 0,
        speed: getNumberOption(options, "speed", 2),
        height: getNumberOption(options, "height", 0.036),
      },
      "AiNex is walking backward.",
      "walk backward",
    );
  },
};
