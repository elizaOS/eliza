import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const runActionGroupAction: Action = {
  name: "AINEX_RUN_ACTION_GROUP",
  similes: ["RUN_ACTION_GROUP", "PLAY_ACTION", "PLAY_ACTION_GROUP"],
  description:
    "Play a named Hiwonder action group (pre-recorded multi-servo motion) by id.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = "(ainex stub) run action group not implemented yet";
    await callback?.({ text });
    return { success: false, text };
  },
};
