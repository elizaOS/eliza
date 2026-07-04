/**
 * FILE `read` handler: returns file contents (line-numbered, size- and
 * line-capped) after validating the path through SandboxService, and records the
 * read with FileStateService so a later write/edit can detect external
 * modification. Supports the `device_filesystem` bridge when reading device files.
 */
import * as fs from "node:fs/promises";

import {
  type ActionResult,
  CapabilityError,
  logger as coreLogger,
  getCapabilityRouter,
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
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

type ReadTextPayload = {
  text: string;
  size: number;
};

function formatLine(lineNumber: number, content: string): string {
  return `${String(lineNumber).padStart(6, " ")}\t${content}`;
}

async function finalizeReadResult(params: {
  runtime: IAgentRuntime;
  callback?: HandlerCallback;
  conversationId: string;
  fileState: InstanceType<typeof FileStateService>;
  resolved: string;
  text: string;
  options: unknown;
}): Promise<ActionResult> {
  const lines = params.text.split("\n");
  const totalLines = lines.length;

  const offset = Math.max(
    0,
    Math.floor(readNumberParam(params.options, "offset") ?? 0),
  );
  const requestedLimit = readNumberParam(params.options, "limit");
  const defaultLimit = readPositiveIntSetting(
    params.runtime,
    "CODING_TOOLS_MAX_READ_LINES",
    2000,
  );
  const limit = Math.max(1, Math.floor(requestedLimit ?? defaultLimit));

  const endExclusive = Math.min(totalLines, offset + limit);
  const slice = lines.slice(offset, endExclusive);
  const truncated = endExclusive < totalLines || offset > 0;

  const formatted = [
    params.resolved,
    ...slice.map((content, idx) => formatLine(offset + idx + 1, content)),
  ].join("\n");

  await params.fileState.recordRead(params.conversationId, params.resolved);
  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} READ ${params.resolved} offset=${offset} returned=${slice.length}/${totalLines}`,
  );

  if (params.callback) {
    await params.callback({ text: formatted, source: "coding-tools" });
  }

  return successActionResult(formatted, {
    path: params.resolved,
    lines: slice.length,
    totalLines,
    offset,
    truncated,
  });
}

async function readWithCapabilityRouter(params: {
  runtime: IAgentRuntime;
  resolved: string;
  maxBytes: number;
}): Promise<
  | { ok: true; payload: ReadTextPayload }
  | { ok: false; reason: "unavailable" | "failed"; message: string }
> {
  const router = getCapabilityRouter(params.runtime);
  if (!router) return { ok: false, reason: "unavailable", message: "" };
  try {
    const result = await router.fs.readText({
      path: params.resolved,
      maxBytes: params.maxBytes,
    });
    if (result.size > params.maxBytes || result.truncated) {
      return {
        ok: false,
        reason: "failed",
        message: `file size ${result.size} exceeds ${params.maxBytes}; use offset/limit to read in chunks`,
      };
    }
    return {
      ok: true,
      payload: {
        text: result.text,
        size: result.size,
      },
    };
  } catch (error) {
    if (
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE"
    ) {
      return { ok: false, reason: "unavailable", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "failed", message };
  }
}

export async function readFileHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
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
  if (validated.ok === false) {
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

  const routed = await readWithCapabilityRouter({
    runtime,
    resolved,
    maxBytes,
  });
  if (routed.ok) {
    return finalizeReadResult({
      runtime,
      callback,
      conversationId,
      fileState,
      resolved,
      text: routed.payload.text,
      options,
    });
  }
  if (routed.reason === "failed") {
    return failureToActionResult({
      reason: "io_error",
      message: routed.message,
    });
  }

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
      message: `binary file detected at ${resolved}; use SHELL+xxd or similar to inspect`,
    });
  }

  const text = buffer.toString("utf8");
  return finalizeReadResult({
    runtime,
    callback,
    conversationId,
    fileState,
    resolved,
    text,
    options,
  });
}
