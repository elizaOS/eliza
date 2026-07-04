/**
 * Echo action implementation for the reference plugin example.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * ECHO — repeats the user's message back. The smallest useful action: it has a
 * trivial validator, reads the incoming text, and returns it as the result.
 */
export const echoAction: Action = {
  name: "ECHO",
  similes: ["REPEAT", "SAY_BACK"],
  description:
    "Repeat the user's message back to them verbatim. Use when the user asks the agent to echo or repeat something.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return (
      typeof message.content.text === "string" &&
      message.content.text.length > 0
    );
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content.text ?? "";
    if (callback) {
      await callback({ text, actions: ["ECHO"] });
    }
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
    };
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "echo: hello world" } },
      {
        name: "{{agent}}",
        content: { text: "hello world", actions: ["ECHO"] },
      },
    ],
  ],
};
