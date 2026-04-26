import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";

const APP_NAME = "__APP_NAME__";

const helloAction: Action = {
  name: "__APP_NAME___HELLO",
  similes: ["GREET", "SAY_HELLO"],
  description: `Trivial smoke action exposed by the ${APP_NAME} app plugin.`,
  examples: [],
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const text = `Hello from ${APP_NAME}.`;
    await callback?.({ text });
    return { success: true, text };
  },
};

const plugin: Plugin = {
  name: APP_NAME,
  description: `Runtime plugin for the ${APP_NAME} app.`,
  actions: [helloAction],
};

export default plugin;
export { plugin, helloAction };
