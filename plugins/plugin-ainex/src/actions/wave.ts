import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { sendOne } from "./_helpers";

export const waveAction: Action = {
  name: "AINEX_WAVE",
  similes: ["WAVE", "WAVE_HAND", "GREET", "SAY_HI"],
  description: "Play the `wave` action group on the AiNex robot.",
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
      { name: "wave" },
      "AiNex is waving.",
      "wave",
    );
  },
};
