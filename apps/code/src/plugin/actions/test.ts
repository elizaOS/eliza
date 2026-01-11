import * as fs from "node:fs/promises";
import * as path from "node:path";
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
import {
  createFileNotFoundError,
  formatErrorForDisplay,
} from "../../lib/errors.js";
import {
  CODE_GENERATION_SYSTEM_PROMPT,
  createFileContextBlock,
} from "../../lib/prompts.js";
import { getCwd } from "../providers/cwd.js";

function extractFilePath(text: string): string {
  const patterns = [
    /(?:test|generate\s+tests?\s+for)\s+(?:the\s+)?["']?([^\s"']+\.[a-zA-Z0-9]+)["']?/i,
    /["']([^"']+\.[a-zA-Z0-9]+)["']/,
    /`([^`]+\.[a-zA-Z0-9]+)`/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function extractTestFramework(text: string): string {
  if (text.includes("jest")) return "jest";
  if (text.includes("vitest")) return "vitest";
  if (text.includes("mocha")) return "mocha";
  if (text.includes("bun")) return "bun:test";
  return "vitest";
}

export const testAction: Action = {
  name: "TEST",
  similes: ["GENERATE_TESTS", "CREATE_TESTS", "WRITE_TESTS"],
  description: `Generate comprehensive test cases for a specified file.

USE THIS ACTION WHEN:
- User says "test", "generate tests", or "write tests" for a file
- User wants unit tests, specs, or test coverage for code
- User references a file and asks for testing

DO NOT USE WHEN:
- User wants to run existing tests (use EXECUTE_SHELL with test command)
- User wants to understand code (use EXPLAIN)
- User has no specific file to test
- User wants integration or E2E tests (may need CREATE_TASK for complex setups)

BEHAVIOR:
- Reads the specified source file
- Generates tests using detected or specified framework
- Includes edge cases and error handling tests
- Supports Jest, Vitest, Mocha, and Bun test frameworks
- Auto-detects framework from user message or defaults to Vitest

REQUIRES: A valid file path to the code that should be tested.
OUTPUT: Generated test code (displayed, not automatically saved to file).`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("test") || text.includes("spec") || text.includes("unit")
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
    const filePath = extractFilePath(text);

    if (!filePath) {
      const msg = "Please specify which file to generate tests for.";
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }

    const fullPath = path.resolve(getCwd(), filePath);
    const framework = extractTestFramework(text);

    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const ext = path.extname(filePath).slice(1) || "txt";

      const prompt = `${CODE_GENERATION_SYSTEM_PROMPT}\n\n${createFileContextBlock(filePath, content, ext)}\n\nGenerate comprehensive tests using ${framework}. Include edge cases and error handling tests.`;

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: 4000,
        temperature: 0.3,
      });

      const tests =
        typeof result === "string"
          ? result.trim()
          : ((result as { text?: string })?.text?.trim() ??
            "Could not generate tests.");

      await callback?.({ text: tests });
      return {
        success: true,
        text: tests,
        data: { filepath: filePath, framework },
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        const notFoundError = createFileNotFoundError(filePath);
        const msg = formatErrorForDisplay(notFoundError);
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }
      logger.error(`TEST error: ${error.message}`);
      await callback?.({ text: `Error: ${error.message}` });
      return { success: false, text: error.message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "generate tests for src/utils.ts" },
      },
      {
        name: "{{agent}}",
        content: { text: "Generating tests...", actions: ["TEST"] },
      },
    ],
  ],
};
