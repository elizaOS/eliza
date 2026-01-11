import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { CODE_GENERATION_SYSTEM_PROMPT } from "../../lib/prompts.js";

export const generateAction: Action = {
  name: "GENERATE",
  similes: ["WRITE_CODE", "GENERATE_CODE", "CREATE_CODE", "SCAFFOLD"],
  description: `Generate code snippets, functions, or components based on a description without writing to files.

USE THIS ACTION WHEN:
- User says "generate", "write code", or "create code" without a file path
- User wants a code snippet, function, class, or algorithm
- User asks for code examples or implementations
- User wants code output displayed rather than saved

DO NOT USE WHEN:
- User provides a specific file path (use WRITE_FILE instead)
- User wants to modify existing code (use EDIT_FILE)
- User wants a complete project or multi-file feature (use CREATE_TASK)
- User wants an explanation rather than code (use ASK or EXPLAIN)

BEHAVIOR:
- Generates code based on the request description
- Returns code directly to the user (not written to filesystem)
- Focuses on clean, production-ready code
- Does NOT create or modify files

OUTPUT: Generated code displayed to user. Use WRITE_FILE if the code should be saved to a file.`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    const hasGenerateIntent =
      text.includes("generate") ||
      text.includes("write") ||
      text.includes("create code");

    // If the user provided an explicit file path (e.g., "index.html"), prefer WRITE_FILE / EDIT_FILE.
    const hasFileExtension = /\.[a-z0-9]{1,8}\b/i.test(text);
    if (hasFileExtension) return false;

    return hasGenerateIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const request = message.content.text ?? "";

    const prompt = `${CODE_GENERATION_SYSTEM_PROMPT}\n\nUser request:\n${request}\n\nGenerate the requested code.`;

    try {
      // biome-ignore lint/correctness/useHookAtTopLevel: useModel is a runtime method, not a React hook
      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: 2000,
        temperature: 0.3,
      });

      const text =
        typeof result === "string" ? result.trim() : String(result).trim();
      await callback?.({ text });
      return { success: true, text };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`GENERATE error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Generate a quicksort function in TypeScript." },
      },
      {
        name: "{{agent}}",
        content: { text: "Generating...", actions: ["GENERATE"] },
      },
    ],
  ],
};
