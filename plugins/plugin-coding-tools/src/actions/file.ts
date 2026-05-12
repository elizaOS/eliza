import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";
import { editFileHandler } from "./edit.js";
import { globHandler } from "./glob.js";
import { grepHandler } from "./grep.js";
import { lsHandler } from "./ls.js";
import { readFileHandler } from "./read.js";
import { writeFileHandler } from "./write.js";

const FILE_OPERATIONS = [
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "ls",
] as const;
type FileOperation = (typeof FILE_OPERATIONS)[number];
type FileTarget = "workspace" | "device";

const DEVICE_FILESYSTEM_SERVICE_TYPE = "device_filesystem";
const DEVICE_TARGET_VALUES = new Set([
  "device",
  "device_filesystem",
  "device-filesystem",
  "mobile",
  "phone",
  "local_device",
  "local-device",
]);

type FileEncoding = "utf8" | "base64";

interface DeviceDirectoryEntry {
  name: string;
  type: "file" | "directory";
}

interface DeviceFilesystemBridgeLike {
  read(path: string, encoding?: FileEncoding): Promise<string>;
  write(path: string, content: string, encoding?: FileEncoding): Promise<void>;
  list(path: string): Promise<DeviceDirectoryEntry[]>;
}

type FileHandler = (
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined,
) => Promise<ActionResult>;

const FILE_ACTIONS: Record<FileOperation, FileHandler> = {
  read: readFileHandler,
  write: writeFileHandler,
  edit: editFileHandler,
  grep: grepHandler,
  glob: globHandler,
  ls: lsHandler,
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

const DEVICE_FILE_OPERATION_ALIASES: Record<string, FileOperation> = {
  device_file_read: "read",
  read_device_file: "read",
  device_read_file: "read",
  device_file_write: "write",
  write_device_file: "write",
  device_write_file: "write",
  device_list_dir: "ls",
  list_device_dir: "ls",
  device_ls: "ls",
};

function readFileTarget(options: unknown): FileTarget {
  for (const key of ["target", "scope", "source"]) {
    const raw = readStringParam(options, key);
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase();
    if (DEVICE_TARGET_VALUES.has(normalized)) return "device";
  }
  return "workspace";
}

function readFileRouting(
  options: unknown,
): { operation: FileOperation; target: FileTarget } | undefined {
  const explicitTarget = readFileTarget(options);
  for (const key of ["action", "subaction", "op", "operation", "verb"]) {
    const raw = readStringParam(options, key);
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
    if ((FILE_OPERATIONS as readonly string[]).includes(normalized)) {
      return {
        operation: normalized as FileOperation,
        target: explicitTarget,
      };
    }
    const deviceAlias = DEVICE_FILE_OPERATION_ALIASES[normalized];
    if (deviceAlias) return { operation: deviceAlias, target: "device" };
    const alias = FILE_OPERATION_ALIASES[normalized];
    if (alias) return { operation: alias, target: explicitTarget };
  }
  return undefined;
}

function getDeviceFilesystemBridge(
  runtime: IAgentRuntime,
): DeviceFilesystemBridgeLike | null {
  const service = runtime.getService(DEVICE_FILESYSTEM_SERVICE_TYPE) as unknown;
  if (service && typeof service === "object") {
    const candidate = service as Partial<DeviceFilesystemBridgeLike>;
    if (
      typeof candidate.read === "function" &&
      typeof candidate.write === "function" &&
      typeof candidate.list === "function"
    ) {
      return candidate as DeviceFilesystemBridgeLike;
    }
  }
  return null;
}

function readDevicePath(
  options: unknown,
  operation: FileOperation,
): string | undefined {
  const path =
    readStringParam(options, "path") ?? readStringParam(options, "file_path");
  if (path !== undefined) return path;
  return operation === "ls" ? "" : undefined;
}

function readDeviceEncoding(options: unknown): FileEncoding | undefined {
  const encoding = readStringParam(options, "encoding");
  if (encoding === undefined) return "utf8";
  if (encoding === "utf8" || encoding === "base64") return encoding;
  return undefined;
}

function renderDeviceEntries(
  path: string,
  entries: DeviceDirectoryEntry[],
): string {
  if (entries.length === 0) {
    return `(${path || "."}: empty)`;
  }
  const lines = entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      entry.type === "directory" ? `${entry.name}/` : entry.name,
    );
  return `${path || "."}:\n${lines.join("\n")}`;
}

async function deviceFileHandler(
  operation: FileOperation,
  runtime: IAgentRuntime,
  options: unknown,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  if (operation !== "read" && operation !== "write" && operation !== "ls") {
    return failureToActionResult({
      reason: "invalid_param",
      message: "FILE target=device supports action=read/write/ls",
    });
  }

  const bridge = getDeviceFilesystemBridge(runtime);
  if (!bridge) {
    return failureToActionResult({
      reason: "internal",
      message: "device filesystem bridge service unavailable",
    });
  }

  const path = readDevicePath(options, operation);
  if (path === undefined || (operation !== "ls" && path.length === 0)) {
    return failureToActionResult({
      reason: "missing_param",
      message: operation === "write" ? "path is required" : "path is required",
    });
  }

  const encoding = readDeviceEncoding(options);
  if (!encoding) {
    return failureToActionResult({
      reason: "invalid_param",
      message: "encoding must be utf8 or base64",
    });
  }

  if (operation === "read") {
    const content = await bridge.read(path, encoding);
    const bytes = Buffer.byteLength(content, encoding);
    const text = `Read ${bytes} byte${bytes === 1 ? "" : "s"} from ${path}`;
    if (callback) await callback({ text, source: "coding-tools" });
    return successActionResult(text, {
      action: "FILE",
      target: "device",
      operation,
      path,
      encoding,
      bytes,
      content,
    });
  }

  if (operation === "write") {
    const content = readStringParam(options, "content");
    if (content === undefined) {
      return failureToActionResult({
        reason: "missing_param",
        message: "content is required",
      });
    }
    await bridge.write(path, content, encoding);
    const bytes = Buffer.byteLength(content, encoding);
    const text = `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${path}`;
    if (callback) await callback({ text, source: "coding-tools" });
    return successActionResult(text, {
      action: "FILE",
      target: "device",
      operation,
      path,
      encoding,
      bytes,
    });
  }

  const entries = await bridge.list(path);
  const text = renderDeviceEntries(path, entries);
  if (callback) await callback({ text, source: "coding-tools" });
  return successActionResult(text, {
    action: "FILE",
    target: "device",
    operation,
    path,
    entries,
  });
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
    "DEVICE_FILE_READ",
    "DEVICE_FILE_WRITE",
    "DEVICE_LIST_DIR",
    "READ_DEVICE_FILE",
    "WRITE_DEVICE_FILE",
    "LIST_DEVICE_DIR",
  ],
  description:
    "Read, write, edit, search, find, or list files through one FILE action. Choose action=read/write/edit/grep/glob/ls. Use target=device for device-filesystem reads, writes, and directory lists; workspace paths must be absolute unless an operation explicitly defaults to the session cwd.",
  descriptionCompressed:
    "File operations umbrella: action=read/write/edit/grep/glob/ls, optional target=device.",
  parameters: [
    {
      name: "action",
      description: "File operation to run.",
      required: true,
      schema: { type: "string", enum: [...FILE_OPERATIONS] },
    },
    {
      name: "target",
      description:
        "Optional target filesystem. Use device for relative paths under the device filesystem bridge; omit for workspace files.",
      required: false,
      schema: { type: "string", enum: ["workspace", "device"] },
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
      description:
        "For action=edit, replace every occurrence instead of requiring one match.",
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
      description:
        "For action=grep, include 1-based line numbers in content output.",
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
    {
      name: "encoding",
      description:
        "For target=device read/write: utf8 or base64. Defaults to utf8.",
      required: false,
      schema: { type: "string", enum: ["utf8", "base64"] },
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
    const routing = readFileRouting(options);
    if (!routing) {
      return failureToActionResult({
        reason: "missing_param",
        message: "FILE requires action=read/write/edit/grep/glob/ls",
      });
    }
    const { operation, target } = routing;
    if (target === "device") {
      return deviceFileHandler(operation, runtime, options, callback);
    }
    const handler = FILE_ACTIONS[operation];
    const result = await handler(
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
          thought:
            "Reading a file maps to FILE with action=read and file_path.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Find every TypeScript file under the repo.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found matching files.",
          actions: ["FILE"],
          thought:
            "File discovery maps to FILE with action=glob, pattern, and path.",
        },
      },
    ],
  ],
};
