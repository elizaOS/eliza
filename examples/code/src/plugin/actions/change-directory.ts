import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getCwd, setCwd } from "../providers/cwd.js";

function extractPath(text: string): string {
  const patterns = [
    /(?:cd|change\s+(?:directory|dir|to)|go\s+to)\s+["']?([^\s"']+)["']?/i,
    /(?:switch|move)\s+(?:to\s+)?["']?([^\s"']+)["']?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

export const changeDirectoryAction: Action = {
  name: "CHANGE_DIRECTORY",
  similes: ["CD", "CHDIR", "GO_TO_DIRECTORY"],
  description: `Change the current working directory for file operations and command execution.

USE THIS ACTION WHEN:
- User says "cd", "change directory", "go to", or "switch to" followed by a path
- User wants to navigate to a different folder before performing operations
- User asks "what directory am I in" or "where am I" (returns current CWD)

DO NOT USE WHEN:
- User wants to list files in a directory (use LIST_FILES)
- User wants to read a file from a different directory (use READ_FILE with full path)
- User mentions a path but doesn't want to change context

BEHAVIOR:
- Supports relative paths (../src, ./lib) and absolute paths (/home/user/project)
- If no path is provided, returns the current working directory
- Validates that the target directory exists before changing
- All subsequent file operations use the new CWD as base`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("cd ") ||
      text.includes("change dir") ||
      text.includes("go to") ||
      text.includes("switch to") ||
      text.includes("working directory")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const targetPath = extractPath(message.content.text ?? "");

    if (!targetPath) {
      const result = `CWD: ${getCwd()}`;
      await callback?.({ text: result });
      return { success: true, text: result, data: { cwd: getCwd() } };
    }

    const result = await setCwd(targetPath);

    if (result.success) {
      const msg = `CWD: ${result.path}`;
      await callback?.({ text: msg });
      return { success: true, text: msg, data: { cwd: result.path } };
    } else {
      const msg = `Error: ${result.error}`;
      await callback?.({ text: msg });
      return {
        success: false,
        text: result.error ?? "Failed to change directory",
      };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "cd src" } },
      {
        name: "{{agent}}",
        content: {
          text: "Changing directory...",
          actions: ["CHANGE_DIRECTORY"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "go to /home/user/projects" } },
      {
        name: "{{agent}}",
        content: { text: "Navigating...", actions: ["CHANGE_DIRECTORY"] },
      },
    ],
  ],
};
