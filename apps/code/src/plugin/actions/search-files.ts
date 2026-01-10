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

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

function extractSearchParams(text: string): { pattern: string; directory: string } {
  let pattern = "";
  let directory = ".";

  const patternPatterns = [
    /(?:search|find|grep|look)\s+(?:for\s+)?["']([^"']+)["']/i,
    /(?:search|find|grep|look)\s+(?:for\s+)?(\S+)/i,
  ];

  for (const p of patternPatterns) {
    const match = text.match(p);
    if (match?.[1]) {
      pattern = match[1];
      break;
    }
  }

  const dirMatch = text.match(/(?:in|within|under)\s+["']?([^\s"']+)["']?/i);
  if (dirMatch?.[1] && !["the", "all", "files"].includes(dirMatch[1].toLowerCase())) {
    directory = dirMatch[1];
  }

  return { pattern, directory };
}

async function searchInDirectory(
  dir: string,
  pattern: string,
  matches: SearchMatch[],
  maxMatches = 50
): Promise<void> {
  if (matches.length >= maxMatches) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= maxMatches) break;
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "dist", "build", ".git", "coverage"].includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await searchInDirectory(fullPath, pattern, matches, maxMatches);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const textExtensions = [
          ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt",
          ".html", ".css", ".scss", ".yaml", ".yml", ".toml",
          ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
          ".sh", ".bash", ".zsh", ".env",
        ];

        if (!textExtensions.includes(ext) && !entry.name.includes(".")) continue;

        try {
          const content = await fs.readFile(fullPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxMatches) break;
            if (lines[i].toLowerCase().includes(pattern.toLowerCase())) {
              matches.push({
                file: path.relative(getCwd(), fullPath),
                line: i + 1,
                content: lines[i].trim().substring(0, 200),
              });
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }
  } catch {
    // Skip directories that can't be read
  }
}

export const searchFilesAction: Action = {
  name: "SEARCH_FILES",
  similes: ["GREP", "FIND_IN_FILES", "SEARCH_CODE"],
  description: `Search for text patterns across multiple files in the codebase.

USE THIS ACTION WHEN:
- User says "search", "find", "grep", or "look for" with a pattern
- User asks "where is" something defined or used
- User wants to find all occurrences of a string or pattern
- User wants to locate code across the project

DO NOT USE WHEN:
- User wants to list files in a directory (use LIST_FILES)
- User wants to read a specific file (use READ_FILE)
- User knows the exact file and wants to see it (use READ_FILE)
- User wants to find files by name pattern (use LIST_FILES with path)

BEHAVIOR:
- Recursively searches through text files
- Case-insensitive matching
- Skips binary files and common ignore directories (node_modules, dist, .git)
- Groups results by file with line numbers
- Limited to 50 matches to prevent overwhelming output

SUPPORTED PATTERNS:
- "search for 'TODO'" → finds all TODO comments
- "find handleClick in src" → searches src directory
- "where is UserService" → finds all UserService references

OUTPUT: Grouped results showing file path, line numbers, and matching content.`,

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("search") ||
      text.includes("find") ||
      text.includes("grep") ||
      text.includes("where is") ||
      text.includes("look for")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const { pattern, directory } = extractSearchParams(message.content.text ?? "");

    if (!pattern) {
      const msg = "Please specify what to search for.";
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }

    const fullPath = path.resolve(getCwd(), directory);

    try {
      const matches: SearchMatch[] = [];
      await searchInDirectory(fullPath, pattern, matches);

      if (matches.length === 0) {
        const result = `No matches found for "${pattern}"`;
        await callback?.({ text: result });
        return { success: true, text: result, data: { pattern, matches: [] } };
      }

      const byFile = new Map<string, SearchMatch[]>();
      for (const match of matches) {
        const existing = byFile.get(match.file) ?? [];
        existing.push(match);
        byFile.set(match.file, existing);
      }

      let resultText = `**Search: "${pattern}"** (${matches.length} matches in ${byFile.size} files)\n\n`;
      for (const [file, fileMatches] of byFile) {
        resultText += `**${file}**\n`;
        for (const m of fileMatches.slice(0, 5)) {
          resultText += `  L${m.line}: \`${m.content}\`\n`;
        }
        if (fileMatches.length > 5) {
          resultText += `  ... +${fileMatches.length - 5} more\n`;
        }
        resultText += "\n";
      }

      await callback?.({ text: resultText });
      return { success: true, text: resultText, data: { pattern, matches } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`SEARCH_FILES error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "search for 'TODO' in src" } },
      { name: "{{agent}}", content: { text: "Searching...", actions: ["SEARCH_FILES"] } },
    ],
  ],
};
