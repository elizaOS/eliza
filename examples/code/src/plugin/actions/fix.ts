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

export const fixAction: Action = {
  name: "FIX",
  similes: ["DEBUG", "BUGFIX", "REPAIR"],
  description: `Analyze code to identify bugs and propose specific fixes.

USE THIS ACTION WHEN:
- User says "fix", "debug", or "bug" with a file reference
- User reports an error or unexpected behavior in specific code
- User wants help identifying why code isn't working
- User provides error messages and wants solutions

DO NOT USE WHEN:
- User wants general code improvements (use REFACTOR)
- User wants security/quality review (use REVIEW)
- User asks general debugging questions without a file (use ASK)
- User wants to understand code without fixing it (use EXPLAIN)
- User wants to apply the fix (use EDIT_FILE after getting suggestions)

BEHAVIOR:
- Reads the specified file from filesystem
- Analyzes code for potential bugs, errors, and issues
- Proposes specific fixes with explanations
- Does NOT automatically apply changes (user must confirm)

REQUIRES: A valid file path that can be extracted from the user's message.
OUTPUT: Bug analysis and proposed code fixes (not applied automatically).`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("fix") || text.includes("bug") || text.includes("debug")
    );
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
      "You are an expert debugging assistant. Identify likely causes and propose fixes.",
      "",
      `File: ${file.filepath}`,
      "",
      `\`\`\`${file.extension}`,
      file.content,
      "```",
      "",
      "User report / request:",
      text,
    ].join("\n");

    try {
      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: 2200,
        temperature: 0.2,
      });
      const out =
        typeof result === "string" ? result.trim() : String(result).trim();
      await callback?.({ text: out });
      return { success: true, text: out };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`FIX error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },
};
