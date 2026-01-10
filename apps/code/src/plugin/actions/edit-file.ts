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

interface EditParams {
  filepath: string;
  oldStr: string;
  newStr: string;
}

function extractEditParams(text: string): EditParams {
  let filepath = "";
  let oldStr = "";
  let newStr = "";

  const pathPatterns = [
    /(?:edit|modify|update|change)\s+(?:file\s+)?["']?([^\s"']+\.[a-zA-Z0-9]+)["']?/i,
    /(?:in|file)\s+["']?([^\s"']+\.[a-zA-Z0-9]+)["']?/i,
  ];

  for (const pattern of pathPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      filepath = match[1];
      break;
    }
  }

  const codeBlocks = text.match(/```[\w]*\n?([\s\S]*?)```/g);
  if (codeBlocks && codeBlocks.length >= 2) {
    oldStr = codeBlocks[0].replace(/```[\w]*\n?/, "").replace(/```$/, "").trim();
    newStr = codeBlocks[1].replace(/```[\w]*\n?/, "").replace(/```$/, "").trim();
  } else if (codeBlocks && codeBlocks.length === 1) {
    newStr = codeBlocks[0].replace(/```[\w]*\n?/, "").replace(/```$/, "").trim();
  }

  const replaceMatch = text.match(/replace\s+["'](.+?)["']\s+with\s+["'](.+?)["']/i);
  if (replaceMatch) {
    oldStr = replaceMatch[1];
    newStr = replaceMatch[2];
  }

  return { filepath, oldStr, newStr };
}

export const editFileAction: Action = {
  name: "EDIT_FILE",
  similes: ["MODIFY_FILE", "UPDATE_FILE", "CHANGE_FILE", "REPLACE_IN_FILE"],
  description: `Edit an existing file by finding and replacing specific text content.

USE THIS ACTION WHEN:
- User wants to modify, update, or change specific content in an existing file
- User provides both the old text to find and new text to replace it with
- User wants to fix a typo, update a value, or make targeted changes
- User references an existing file and describes what to change

DO NOT USE WHEN:
- File doesn't exist yet (use WRITE_FILE to create new files)
- User wants to completely rewrite a file (use WRITE_FILE)
- User wants to append content without replacing (consider WRITE_FILE)
- No specific replacement target is provided

INPUTS EXPECTED:
- A file path (extracted from natural language or explicit path)
- Old text to find (from code blocks or quoted text)
- New text to replace with (from code blocks or quoted text)

If only new content is provided without old content, the entire file will be replaced.`,

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("edit") ||
      text.includes("modify") ||
      text.includes("update") ||
      text.includes("change") ||
      text.includes("replace")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = message.content.text ?? "";
    let { filepath, oldStr, newStr } = extractEditParams(text);

    if (state?.pendingEdit) {
      const pending = state.pendingEdit as EditParams;
      filepath = filepath || pending.filepath;
      oldStr = oldStr || pending.oldStr;
      newStr = newStr || pending.newStr;
    }

    if (!filepath) {
      const msg = "Could not determine which file to edit.";
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }

    const fullPath = path.resolve(getCwd(), filepath);

    try {
      const originalContent = await fs.readFile(fullPath, "utf-8");

      if (!oldStr && newStr) {
        await fs.writeFile(fullPath, newStr, "utf-8");
        const result = `Replaced entire content of ${filepath}`;
        await callback?.({ text: result });
        return { success: true, text: result, data: { filepath, action: "replace" } };
      }

      if (!originalContent.includes(oldStr)) {
        const msg = `Could not find the specified text in ${filepath}`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const newContent = originalContent.replace(oldStr, newStr);
      await fs.writeFile(fullPath, newContent, "utf-8");

      const result = `Edited ${filepath}: replaced ${oldStr.length} chars with ${newStr.length} chars`;
      await callback?.({ text: result });
      return { success: true, text: result, data: { filepath, action: "edit" } };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const msg =
        error.code === "ENOENT"
          ? `File not found: ${filepath}`
          : error.code === "EACCES"
            ? `Permission denied: ${filepath}`
            : `Error: ${error.message}`;
      logger.error(`EDIT_FILE error: ${error.message}`);
      await callback?.({ text: msg });
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: 'edit package.json replace "1.0.0" with "1.1.0"' } },
      { name: "{{agent}}", content: { text: "Updating version...", actions: ["EDIT_FILE"] } },
    ],
  ],
};
