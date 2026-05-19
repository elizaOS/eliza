import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { sendOne } from "./_helpers";

export const stopAction: Action = {
  name: "AINEX_STOP",
  similes: ["STOP", "HALT", "FREEZE", "EMERGENCY_STOP"],
  description:
    "Stop the AiNex robot immediately. Sends walk.command:stop with preempt=true so any in-flight commands or active policy are cleared.",
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
      "walk.command",
      { action: "stop" },
      "AiNex stopped.",
      "stop",
      true,
    );
  },
};
