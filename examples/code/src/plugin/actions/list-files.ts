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
  type State,
} from "@elizaos/core";
import { getCwd } from "../providers/cwd.js";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

function extractDirPath(text: string): string {
  const patterns = [
    /(?:list|ls|show|dir)\s+(?:files?\s+)?(?:in\s+)?["']?([^\s"']+)["']?/i,
    /(?:what'?s?\s+in|contents?\s+of)\s+["']?([^\s"']+)["']?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && !match[1].includes("director")) {
      return match[1];
    }
  }

  return ".";
}

export const listFilesAction: Action = {
  name: "LIST_FILES",
  similes: ["LS", "DIR", "SHOW_DIRECTORY", "LIST_DIRECTORY"],
  description: `List files and directories in a specified path with size information.

USE THIS ACTION WHEN:
- User says "list", "ls", "dir", or "show files"
- User asks "what's in" a directory
- User wants to see directory contents or structure
- User wants to explore the filesystem

DO NOT USE WHEN:
- User wants to read file contents (use READ_FILE)
- User wants to search for text in files (use SEARCH_FILES)
- User wants to change the current directory (use CHANGE_DIRECTORY)
- User wants to find files by pattern across directories (use SEARCH_FILES)

BEHAVIOR:
- Lists immediate children of the specified directory
- Shows directories first, then files (sorted alphabetically)
- Includes file sizes for regular files
- Hides hidden files (starting with .)
- Defaults to current working directory if no path specified

OUTPUT: Formatted list with directories marked with / and file sizes in human-readable format.`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("list") ||
      text.includes("ls") ||
      text.includes("dir") ||
      text.includes("what's in") ||
      text.includes("show files") ||
      text.includes("structure")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const dirPath = extractDirPath(message.content.text ?? "");
    const fullPath = path.resolve(getCwd(), dirPath);

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const files: FileEntry[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;

        const fileEntry: FileEntry = {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        };

        if (entry.isFile()) {
          try {
            const stats = await fs.stat(path.join(fullPath, entry.name));
            fileEntry.size = stats.size;
          } catch {
            // Ignore stat errors
          }
        }

        files.push(fileEntry);
      }

      files.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const lines = files.map((f) => {
        if (f.type === "directory") return `${f.name}/`;
        const sizeStr = f.size !== undefined ? ` (${formatSize(f.size)})` : "";
        return `${f.name}${sizeStr}`;
      });

      const result = `Directory: ${dirPath}\n${lines.join("\n")}\n\n${files.length} items`;

      await callback?.({ text: result });
      return { success: true, text: result, data: { path: dirPath, files } };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      let msg: string;

      if (error.code === "ENOENT") {
        msg = `Directory not found: ${dirPath}`;
      } else if (error.code === "ENOTDIR") {
        msg = `${dirPath} is not a directory`;
      } else if (error.code === "EACCES") {
        msg = `Permission denied: ${dirPath}`;
      } else {
        msg = `Error listing directory: ${error.message}`;
      }

      logger.error(`LIST_FILES error: ${error.message}`);
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "list files in src" } },
      {
        name: "{{agent}}",
        content: { text: "Here are the files:", actions: ["LIST_FILES"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "ls" } },
      {
        name: "{{agent}}",
        content: {
          text: "Listing current directory:",
          actions: ["LIST_FILES"],
        },
      },
    ],
  ],
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
