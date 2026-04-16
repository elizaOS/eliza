/**
 * FILE_ACTION — read, write, edit, append, delete files and list directories.
 *
 * Ported from coasty-ai/open-computer-use local-executor.ts file handlers (Apache 2.0).
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  appendFile,
  deleteFile,
  deleteDirectory,
  editFile,
  fileExists,
  listDirectory,
  readFile,
  writeFile,
} from "../platform/file-ops.js";

export const fileAction: Action = {
  name: "FILE_ACTION",

  similes: [
    "READ_FILE",
    "WRITE_FILE",
    "EDIT_FILE",
    "DELETE_FILE",
    "LIST_DIRECTORY",
    "FILE_OPERATION",
  ],

  description:
    "Perform file operations — read, write, edit, append, delete files, or list directory contents.\n\n" +
    "Available actions:\n" +
    "- read: Read file contents. Requires path.\n" +
    "- write: Write content to a file (creates or overwrites). Requires path and content.\n" +
    "- edit: Find and replace text in a file. Requires path, oldText, and newText.\n" +
    "- append: Append content to a file. Requires path and content.\n" +
    "- delete: Delete a file or directory. Requires path.\n" +
    "- exists: Check if a file or directory exists. Requires path.\n" +
    "- list: List directory contents. Requires path.\n\n" +
    "Credential files, system directories, and network paths are automatically blocked for safety.",

  parameters: [
    {
      name: "action",
      description: "File operation to perform",
      required: true,
      schema: {
        type: "string",
        enum: ["read", "write", "edit", "append", "delete", "exists", "list"],
      },
    },
    {
      name: "path",
      description: "File or directory path",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Content to write or append",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "oldText",
      description: "Text to find (for edit action)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "newText",
      description: "Replacement text (for edit action)",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Read the contents of ~/notes.txt" },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll read that file.", action: "FILE_ACTION" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Write 'hello world' to ~/test.txt" },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll write that file.", action: "FILE_ACTION" },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const params = ((options as Record<string, unknown>)?.parameters ?? {}) as {
      action?: string;
      path?: string;
      content?: string;
      oldText?: string;
      newText?: string;
    };

    if (!params.action && message.content && typeof message.content === "object") {
      Object.assign(params, message.content);
    }

    if (!params.action || !params.path) {
      if (callback) await callback({ text: "File action requires 'action' and 'path'." });
      return { success: false, error: "Missing action or path" };
    }

    let text = "";
    let success = false;

    switch (params.action) {
      case "read": {
        const r = await readFile(params.path);
        success = r.success;
        text = r.success ? (r.content ?? "File is empty.") : `Read failed: ${r.error}`;
        break;
      }
      case "write": {
        if (params.content === undefined) {
          text = "content is required for write";
          break;
        }
        const r = await writeFile(params.path, params.content);
        success = r.success;
        text = r.success ? (r.message ?? `Written to ${r.path}`) : `Write failed: ${r.error}`;
        break;
      }
      case "edit": {
        if (!params.oldText || params.newText === undefined) {
          text = "oldText and newText are required for edit";
          break;
        }
        const r = await editFile(params.path, params.oldText, params.newText);
        success = r.success;
        text = r.success ? (r.message ?? `Edited ${r.path}`) : `Edit failed: ${r.error}`;
        break;
      }
      case "append": {
        if (!params.content) {
          text = "content is required for append";
          break;
        }
        const r = await appendFile(params.path, params.content);
        success = r.success;
        text = r.success ? (r.message ?? `Appended to ${r.path}`) : `Append failed: ${r.error}`;
        break;
      }
      case "delete": {
        const r = await deleteFile(params.path).catch(() => deleteDirectory(params.path!));
        success = r.success;
        text = r.success ? (r.message ?? `Deleted ${r.path}`) : `Delete failed: ${r.error}`;
        break;
      }
      case "exists": {
        const r = await fileExists(params.path);
        success = true;
        text = r.exists
          ? `${r.path} exists (${r.isDirectory ? "directory" : "file"}, ${r.size} bytes)`
          : `${r.path} does not exist`;
        break;
      }
      case "list": {
        const r = await listDirectory(params.path);
        if (r.success && r.items) {
          const listing = r.items
            .map((e) => `${e.type === "directory" ? "dir" : "file"} ${e.name}`)
            .join("\n");
          success = true;
          text = `Contents of ${r.path} (${r.count} items):\n${listing}`;
        } else {
          text = `List failed: ${r.error}`;
        }
        break;
      }
      default:
        text = `Unknown file action: ${params.action}`;
    }

    if (callback) {
      await callback({ text });
    }

    return { success };
  },
};
