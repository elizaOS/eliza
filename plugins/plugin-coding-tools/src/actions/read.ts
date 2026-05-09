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
  readNumberParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import type { FileStateService } from "../services/file-state-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

function formatLine(lineNumber: number, content: string): string {
  return `${String(lineNumber).padStart(6, " ")}\t${content}`;
}

export const readAction: Action = {
  name: "READ",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["READ_FILE", "CAT", "OPEN_FILE"],
  description:
    "Read the contents of a file at an absolute path. Returns numbered lines, capped by a per-call line limit and a per-file byte limit. Use offset/limit to paginate through large files. Required before WRITE/EDIT can mutate an existing file.",
  descriptionCompressed:
    "Read a file by absolute path; returns numbered lines (offset/limit supported).",
  parameters: [
    {
      name: "file_path",
      description: "Absolute path to the file to read.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "offset",
      description: "Zero-based line offset to start reading from.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "limit",
      description: "Max number of lines to return.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (runtime: IAgentRuntime) => {
    return Boolean(
      runtime.getService(SANDBOX_SERVICE) &&
        runtime.getService(FILE_STATE_SERVICE),
    );
  },
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
    if (!filePath) {
      return failureToActionResult({
        reason: "missing_param",
        message: "file_path is required",
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
    if (!validated.ok) {
      const reason =
        validated.reason === "blocked" ? "path_blocked" : "invalid_param";
      return failureToActionResult({ reason, message: validated.message });
    }

    const resolved = validated.resolved;

    const maxBytes = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_MAX_FILE_SIZE_BYTES",
      262_144,
    );

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `stat failed: ${msg}`,
      });
    }

    if (!stat.isFile()) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `path is not a regular file: ${resolved}`,
      });
    }

    if (stat.size > maxBytes) {
      return failureToActionResult({
        reason: "io_error",
        message: `file size ${stat.size} exceeds ${maxBytes}; use offset/limit to read in chunks`,
      });
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `read failed: ${msg}`,
      });
    }

    if (buffer.includes(0)) {
      return failureToActionResult({
        reason: "io_error",
        message: `binary file detected at ${resolved}; use BASH+xxd or similar to inspect`,
      });
    }

    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    const totalLines = lines.length;

    const offset = Math.max(
      0,
      Math.floor(readNumberParam(options, "offset") ?? 0),
    );
    const requestedLimit = readNumberParam(options, "limit");
    const defaultLimit = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_MAX_READ_LINES",
      2000,
    );
    const limit = Math.max(1, Math.floor(requestedLimit ?? defaultLimit));

    const endExclusive = Math.min(totalLines, offset + limit);
    const slice = lines.slice(offset, endExclusive);
    const truncated = endExclusive < totalLines || offset > 0;

    const formatted = [
      resolved,
      ...slice.map((content, idx) => formatLine(offset + idx + 1, content)),
    ].join("\n");

    await fileState.recordRead(conversationId, resolved);
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} READ ${resolved} offset=${offset} returned=${slice.length}/${totalLines}`,
    );

    if (callback) await callback({ text: formatted, source: "coding-tools" });

    return successActionResult(formatted, {
      path: resolved,
      lines: slice.length,
      totalLines,
      offset,
      truncated,
    });
  },
};
