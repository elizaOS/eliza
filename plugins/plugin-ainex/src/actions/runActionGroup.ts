import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getStringOption, sendOne } from "./_helpers";

export const runActionGroupAction: Action = {
  name: "AINEX_RUN_ACTION_GROUP",
  similes: ["RUN_ACTION_GROUP", "PLAY_ACTION", "PLAY_ACTION_GROUP"],
  description:
    "Play a named Hiwonder action group (pre-recorded multi-servo motion). Options: name (required, must match a key in the profile's actions.groups).",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const name = getStringOption(options, "name", "");
    if (name === "") {
      const text = "AINEX_RUN_ACTION_GROUP requires options.name (e.g. 'wave').";
      await callback?.({ text });
      return { success: false, text };
    }
    return sendOne(
      runtime,
      callback,
      "action.play",
      { name },
      `AiNex is playing action group: ${name}.`,
      `run action group '${name}'`,
    );
  },
};
