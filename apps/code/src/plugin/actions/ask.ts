import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  logger,
} from "@elizaos/core";

export const askAction: Action = {
  name: "ASK",
  similes: ["QUESTION", "QNA", "HELP", "ASK_QUESTION"],
  description: `Answer coding questions, explain concepts, and provide technical guidance without modifying any files.

USE THIS ACTION WHEN:
- User asks "how do I...", "what is...", "why does...", or "explain..." questions
- User needs help understanding a concept, pattern, or best practice
- User wants guidance on approach without actual code changes
- Questions about syntax, APIs, libraries, or programming concepts

DO NOT USE WHEN:
- User wants to create, modify, or write files (use WRITE_FILE, EDIT_FILE)
- User wants code generated for a specific file (use GENERATE or WRITE_FILE)
- User wants to understand a specific file in the codebase (use EXPLAIN with a file path)
- User wants a full implementation plan (use PLAN)

This action is read-only and will never modify the filesystem.`,

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("how") ||
      text.includes("what") ||
      text.includes("why") ||
      text.startsWith("explain ") ||
      text.includes("help")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const question = message.content.text ?? "";
    const prompt = [
      "You are an expert software engineer. Answer the user's question clearly and concisely.",
      "",
      "User question:",
      question,
    ].join("\n");

    try {
      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: 1200,
        temperature: 0.2,
      });

      const text = typeof result === "string" ? result.trim() : String(result).trim();
      await callback?.({ text });
      return { success: true, text };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`ASK error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "How do I write a for loop in JavaScript?" } },
      { name: "{{agent}}", content: { text: "I'll explain with an example.", actions: ["ASK"] } },
    ],
  ],
};
