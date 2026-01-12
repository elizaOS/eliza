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
import { extractFilePathFromText, readFileForPrompt } from "./llm-utils.js";

export const explainAction: Action = {
  name: "EXPLAIN",
  similes: ["EXPLAIN_CODE", "DESCRIBE_CODE", "UNDERSTAND_CODE"],
  description: `Provide detailed educational explanations of what a specific file or code does.

USE THIS ACTION WHEN:
- User says "explain" followed by a file path or file name
- User wants to understand how a specific file works
- User asks "what does this file do" with a file reference
- User needs educational breakdown of existing code

DO NOT USE WHEN:
- User asks general coding questions without a file (use ASK)
- User wants to modify the file (use EDIT_FILE)
- User wants code review for issues/bugs (use REVIEW or FIX)
- User wants refactoring suggestions (use REFACTOR)
- No file path can be extracted from the request

BEHAVIOR:
- Reads the specified file from the filesystem
- Provides comprehensive explanation of purpose, structure, and logic
- Educational tone with clear breakdowns
- Does NOT modify any files

REQUIRES: A valid file path that can be extracted from the user's message.`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return text.includes("explain");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content.text ?? "";
    const filepath = extractFilePathFromText(text);
    const file = await readFileForPrompt(filepath);
    if (!file.ok) {
      await callback?.({ text: file.error });
      return { success: false, text: file.error };
    }

    const prompt = [
      "You are an expert software engineer. Explain the following file clearly.",
      "",
      `File: ${file.filepath}`,
      "",
      `\`\`\`${file.extension}`,
      file.content,
      "```",
      "",
      "User request:",
      text,
    ].join("\n");

    try {
      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: 1800,
        temperature: 0.2,
      });
      const out =
        typeof result === "string" ? result.trim() : String(result).trim();
      await callback?.({ text: out });
      return { success: true, text: out };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`EXPLAIN error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },
};
