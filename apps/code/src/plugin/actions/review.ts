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

export const reviewAction: Action = {
  name: "REVIEW",
  similes: ["CODE_REVIEW", "SECURITY_REVIEW", "AUDIT"],
  description: `Perform comprehensive code review focusing on bugs, security, performance, and best practices.

USE THIS ACTION WHEN:
- User says "review" or "audit" with a file reference
- User wants a quality/security assessment of code
- User asks to check code for issues or vulnerabilities
- User wants expert feedback before merging or deploying

DO NOT USE WHEN:
- User has a specific bug to fix (use FIX)
- User wants refactoring suggestions only (use REFACTOR)
- User wants to understand code (use EXPLAIN)
- User wants to apply fixes immediately (use EDIT_FILE after review)
- No file path can be extracted

REVIEW FOCUSES ON:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Code readability and maintainability
- Edge cases and error handling
- Best practices and patterns

REQUIRES: A valid file path that can be extracted from the user's message.
OUTPUT: Detailed review with categorized findings (not applied automatically).`,

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return text.includes("review") || text.includes("audit");
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
      "You are an expert reviewer. Review the following file.",
      "",
      "Focus on: bugs, security, performance, readability, and edge cases.",
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
      logger.error(`REVIEW error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },
};
