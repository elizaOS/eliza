import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import * as fs from "fs/promises";
import * as path from "path";
import { getCwd } from "../providers/cwd.js";

/**
 * Extract file path from user message
 */
function extractFilePath(text: string): string {
  const patterns = [
    /(?:read|show|view|open|cat)\s+(?:the\s+)?(?:file\s+)?["']?([^\s"']+)["']?/i,
    /(?:content|contents)\s+(?:of\s+)?["']?([^\s"']+)["']?/i,
    /["']([^"']+\.[a-zA-Z0-9]+)["']/,
    /`([^`]+\.[a-zA-Z0-9]+)`/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const pathPattern = /(?:\.\/|\/)?[\w\-./]+\.[a-zA-Z0-9]+/;
  const pathMatch = text.match(pathPattern);
  return pathMatch?.[0] ?? "";
}

export const readFileAction: Action = {
  name: "READ_FILE",
  similes: ["VIEW_FILE", "OPEN_FILE", "CAT_FILE", "SHOW_FILE", "GET_FILE"],
  description: `Read and display the contents of a file from the filesystem.

USE THIS ACTION WHEN:
- User says "read", "show", "view", "open", or "cat" with a file reference
- User asks to see the "content" or "contents" of a file
- User references a file path and wants to see what's in it
- User uses backticks or quotes around a file name

DO NOT USE WHEN:
- User wants to list directory contents (use LIST_FILES)
- User wants to understand/explain the file (use EXPLAIN)
- User wants to modify the file (use EDIT_FILE)
- User wants to search for text across files (use SEARCH_FILES)
- Path refers to a directory, not a file

BEHAVIOR:
- Reads the entire file content
- Formats output with syntax highlighting based on file extension
- Returns error for directories (suggests LIST_FILES instead)
- Handles common errors (not found, permission denied)

OUTPUT: File contents wrapped in markdown code block with appropriate language tag.`,

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("read") ||
      text.includes("show") ||
      text.includes("view") ||
      text.includes("open") ||
      text.includes("cat") ||
      text.includes("content")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const filepath = extractFilePath(message.content.text ?? "");

    if (!filepath) {
      const msg = "Could not determine which file to read. Please specify a file path.";
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }

    const fullPath = path.resolve(getCwd(), filepath);

    try {
      const stats = await fs.stat(fullPath);

      if (stats.isDirectory()) {
        const msg = `${filepath} is a directory. Use LIST_FILES to view contents.`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const content = await fs.readFile(fullPath, "utf-8");
      const ext = path.extname(filepath).slice(1) || "txt";
      const result = `**File: ${filepath}**\n\`\`\`${ext}\n${content}\n\`\`\``;

      await callback?.({ text: result });
      return { success: true, text: result, data: { filepath, content, size: stats.size } };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      let msg: string;

      if (error.code === "ENOENT") {
        msg = `File not found: ${filepath}`;
      } else if (error.code === "EACCES") {
        msg = `Permission denied: ${filepath}`;
      } else {
        msg = `Error reading file: ${error.message}`;
      }

      logger.error(`READ_FILE error: ${error.message}`);
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "read the package.json" } },
      { name: "{{agent}}", content: { text: "Reading package.json...", actions: ["READ_FILE"] } },
    ],
    [
      { name: "{{user1}}", content: { text: "show me src/index.ts" } },
      { name: "{{agent}}", content: { text: "Here's src/index.ts:", actions: ["READ_FILE"] } },
    ],
  ],
};
