import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import { failureToActionResult, readStringParam } from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";
import { editAction } from "./edit.js";
import { globAction } from "./glob.js";
import { grepAction } from "./grep.js";
import { lsAction } from "./ls.js";
import { readAction } from "./read.js";
import { writeAction } from "./write.js";

const FILE_OPERATIONS = ["read", "write", "edit", "grep", "glob", "ls"] as const;
type FileOperation = (typeof FILE_OPERATIONS)[number];

const FILE_ACTIONS: Record<FileOperation, Action> = {
  read: readAction,
  write: writeAction,
  edit: editAction,
  grep: grepAction,
  glob: globAction,
  ls: lsAction,
};

const FILE_OPERATION_ALIASES: Record<string, FileOperation> = {
  cat: "read",
  open: "read",
  search: "grep",
  rg: "grep",
  find: "glob",
  list: "ls",
  dir: "ls",
};

function readFileOperation(options: unknown): FileOperation | undefined {
  for (const key of ["action", "subaction", "op", "operation", "verb"]) {
    const raw = readStringParam(options, key);
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
    if ((FILE_OPERATIONS as readonly string[]).includes(normalized)) {
      return normalized as FileOperation;
    }
    const alias = FILE_OPERATION_ALIASES[normalized];
    if (alias) return alias;
  }
  return undefined;
}

export const fileAction: Action = {
  name: "FILE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: [
    "READ",
    "WRITE",
    "EDIT",
    "GREP",
    "GLOB",
    "LS",
    "READ_FILE",
    "WRITE_FILE",
    "EDIT_FILE",
    "FILE_OPERATION",
    "FILE_IO",
  ],
  description:
    "Read, write, edit, search, find, or list workspace files through one FILE action. Choose action=read/write/edit/grep/glob/ls. All paths must be absolute unless an operation explicitly defaults to the session cwd.",
  descriptionCompressed:
    "File operations umbrella: action=read/write/edit/grep/glob/ls.",
  parameters: [
    {
      name: "action",
      description: "File operation to run.",
      required: true,
      schema: { type: "string", enum: [...FILE_OPERATIONS] },
    },
    {
      name: "file_path",
      description: "Absolute path for read/write/edit operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "path",
      description:
        "Absolute file or directory path for grep/glob/ls. Defaults to the session cwd where supported.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Full file contents for action=write.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "old_string",
      description: "Exact substring to replace for action=edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "new_string",
      description: "Replacement substring for action=edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replace_all",
      description: "For action=edit, replace every occurrence instead of requiring one match.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "pattern",
      description: "Regex for action=grep or glob pattern for action=glob.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "glob",
      description: "Optional ripgrep glob filter for action=grep.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "type",
      description: "Optional ripgrep file type for action=grep.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "output_mode",
      description: "For action=grep: content, files_with_matches, or count.",
      required: false,
      schema: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
      },
    },
    {
      name: "-A",
      description: "For action=grep content mode, lines after each match.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "-B",
      description: "For action=grep content mode, lines before each match.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "-C",
      description: "For action=grep content mode, lines around each match.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "case_insensitive",
      description: "For action=grep, match case-insensitively.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "multiline",
      description: "For action=grep, enable multiline regex matching.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "head_limit",
      description: "For action=grep, truncate output to the first N lines.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "show_line_numbers",
      description: "For action=grep, include 1-based line numbers in content output.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "offset",
      description: "For action=read, zero-based line offset.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "limit",
      description: "For action=read, max number of lines to return.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "ignore",
      description: "For action=ls, glob patterns to exclude.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const operation = readFileOperation(options);
    if (!operation) {
      return failureToActionResult({
        reason: "missing_param",
        message: "FILE requires action=read/write/edit/grep/glob/ls",
      });
    }
    const result = await FILE_ACTIONS[operation].handler(
      runtime,
      message,
      state,
      options as HandlerOptions | undefined,
      callback,
    );
    return (
      result ??
      failureToActionResult({
        reason: "internal",
        message: `FILE action=${operation} returned no result`,
      })
    );
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Read /tmp/app.ts.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Read /tmp/app.ts.",
          actions: ["FILE"],
          thought: "Reading a file maps to FILE with action=read and file_path.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Find every TypeScript file under the repo.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found matching files.",
          actions: ["FILE"],
          thought: "File discovery maps to FILE with action=glob, pattern, and path.",
        },
      },
    ],
  ],
};
