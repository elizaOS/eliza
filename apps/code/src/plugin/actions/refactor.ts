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
import { extractFilePathFromText, readFileForPrompt } from "./llm-utils.js";

export const refactorAction: Action = {
  name: "REFACTOR",
  similes: ["IMPROVE_CODE", "CLEAN_UP", "RESTRUCTURE"],
  description: `Analyze code and suggest refactoring improvements for better structure and maintainability.

USE THIS ACTION WHEN:
- User says "refactor" or "clean up" with a file reference
- User wants to improve code quality without changing behavior
- User asks for suggestions to make code more readable
- User wants to restructure or reorganize code

DO NOT USE WHEN:
- User wants to fix bugs or errors (use FIX)
- User wants security/correctness review (use REVIEW)
- User wants to understand code (use EXPLAIN)
- User wants to apply changes immediately (use EDIT_FILE after review)
- No file path can be extracted

BEHAVIOR:
- Reads the specified file from filesystem
- Analyzes for code smells, duplication, complexity
- Suggests concrete improvements with minimal code examples
- Focuses on readability, structure, and maintainability
- Does NOT automatically apply changes

REQUIRES: A valid file path that can be extracted from the user's message.
OUTPUT: Refactoring suggestions and rationale (not applied automatically).`,

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return text.includes("refactor") || text.includes("clean up");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = message.content.text ?? "";
    const filepath = extractFilePathFromText(text);
    const file = await readFileForPrompt(filepath);
    if (!file.ok) {
      await callback?.({ text: file.error });
      return { success: false, text: file.error };
    }

    const prompt = [
      "You are an expert software engineer. Propose a refactor plan for the following file.",
      "",
      "Provide concrete suggestions. If you include code, keep it minimal and focused on changes.",
      "",
      `File: ${file.filepath}`,
      "",
      "```" + file.extension,
      file.content,
      "```",
      "",
      "User request:",
      text,
    ].join("\n");

    try {
      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: 2200,
        temperature: 0.2,
      });
      const out = typeof result === "string" ? result.trim() : String(result).trim();
      await callback?.({ text: out });
      return { success: true, text: out };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`REFACTOR error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },
};
