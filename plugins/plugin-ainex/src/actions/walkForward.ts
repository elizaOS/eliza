import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getNumberOption, startWalking } from "./_helpers";

export const walkForwardAction: Action = {
  name: "AINEX_WALK_FORWARD",
  similes: ["WALK_FORWARD", "MOVE_FORWARD", "GO_FORWARD"],
  description:
    "Start walking the AiNex robot forward. Sends walk.set+walk.command:start to the bridge; the robot keeps walking until AINEX_STOP is issued. Options: speed (1-4), x (0-0.05).",
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
        x: getNumberOption(options, "x", 0.04),
        y: 0,
        yaw: 0,
        speed: getNumberOption(options, "speed", 2),
        height: getNumberOption(options, "height", 0.036),
      },
      "AiNex is walking forward.",
      "walk forward",
    );
  },
};
