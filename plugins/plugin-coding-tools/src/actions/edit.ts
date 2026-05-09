import * as fs from "node:fs/promises";

import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readBoolParam,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { detectSecrets } from "../lib/secrets.js";
import type { FileStateService } from "../services/file-state-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function lineNumberOf(haystack: string, byteIndex: number): number {
  if (byteIndex <= 0) return 1;
  let line = 1;
  for (let i = 0; i < byteIndex && i < haystack.length; i += 1) {
    if (haystack.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export const editAction: Action = {
  name: "EDIT",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["EDIT_FILE", "MODIFY_FILE"],
  description:
    "Replace text in an existing file. Default behavior requires `old_string` to match exactly once; pass `replace_all=true` to substitute every occurrence. The file must have been READ in this session, must still match its recorded mtime, and the new content cannot introduce a detected secret pattern.",
  descriptionCompressed:
    "Replace exact-match text in a file (single match by default; pass replace_all for multiple).",
  parameters: [
    {
      name: "file_path",
      description: "Absolute path to the file to edit.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "old_string",
      description: "Exact substring to replace.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "new_string",
      description: "Replacement text. Must differ from old_string.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "replace_all",
      description:
        "If true, replace every occurrence; otherwise require exactly one match.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const conversationId =
      message.roomId !== undefined && message.roomId !== null
        ? String(message.roomId)
        : undefined;
    if (!conversationId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "no roomId",
      });
    }

    const filePath = readStringParam(options, "file_path");
    const oldStr = readStringParam(options, "old_string");
    const newStr = readStringParam(options, "new_string");
    const replaceAll = readBoolParam(options, "replace_all") ?? false;
    if (!filePath || oldStr === undefined || newStr === undefined) {
      return failureToActionResult({
        reason: "missing_param",
        message: "file_path, old_string, and new_string are required",
      });
    }
    if (oldStr === newStr) {
      return failureToActionResult({
        reason: "invalid_param",
        message: "old_string and new_string are identical; nothing to do",
      });
    }

    const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
      typeof SandboxService
    > | null;
    const fileState = runtime.getService(FILE_STATE_SERVICE) as InstanceType<
      typeof FileStateService
    > | null;
    if (!sandbox || !fileState) {
      return failureToActionResult({
        reason: "internal",
        message: "coding-tools services unavailable",
      });
    }

    const validated = await sandbox.validatePath(conversationId, filePath);
    if (validated.ok === false) {
      const reason =
        validated.reason === "blocked" ? "path_blocked" : "invalid_param";
      return failureToActionResult({ reason, message: validated.message });
    }

    const resolved = validated.resolved;

    const gate = await fileState.assertWritable(conversationId, resolved);
    if (gate.ok === false) {
      const reason =
        gate.reason === "stale_read" ? "stale_read" : "invalid_param";
      return failureToActionResult({ reason, message: gate.message });
    }

    let original: string;
    try {
      original = await fs.readFile(resolved, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `read failed: ${msg}`,
      });
    }

    const occurrences = countOccurrences(original, oldStr);
    if (occurrences === 0) {
      return failureToActionResult({
        reason: "no_match",
        message: `old_string not found in ${resolved}`,
      });
    }
    if (!replaceAll && occurrences > 1) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `ambiguous: ${occurrences} matches; pass replace_all=true or extend old_string`,
      });
    }

    const firstIndex = original.indexOf(oldStr);
    const firstLine = lineNumberOf(original, firstIndex);

    const updated = replaceAll
      ? original.split(oldStr).join(newStr)
      : `${original.slice(0, firstIndex)}${newStr}${original.slice(firstIndex + oldStr.length)}`;
    const replacements = replaceAll ? occurrences : 1;

    const secrets = detectSecrets(newStr);
    if (secrets.length > 0) {
      const names = secrets.map((s) => s.name).join(", ");
      return failureToActionResult({
        reason: "invalid_param",
        message: `refusing to introduce content matching secret patterns: ${names}`,
      });
    }

    try {
      await fs.writeFile(resolved, updated, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `write failed: ${msg}`,
      });
    }

    await fileState.recordWrite(conversationId, resolved);
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} EDIT ${resolved} replacements=${replacements} firstLine=${firstLine}`,
    );

    const text = `Replaced ${replacements} occurrence${replacements === 1 ? "" : "s"} in ${resolved} (first at line ${firstLine})`;
    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      path: resolved,
      replacements,
      firstLine,
    });
  },
};
