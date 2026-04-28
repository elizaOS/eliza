import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

const PLUGIN_NAME = "__PLUGIN_NAME__";

export const helloAction: Action = {
  name: "__PLUGIN_NAME___HELLO",
  similes: ["GREET", "SAY_HELLO"],
  description: `Trivial smoke action exposed by the ${PLUGIN_NAME} plugin.`,
  examples: [],
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const text = `Hello from ${PLUGIN_NAME}.`;
    await callback?.({ text });
    return { success: true, text };
  },
};
