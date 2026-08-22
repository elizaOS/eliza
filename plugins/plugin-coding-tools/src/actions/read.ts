/**
 * FILE `read` handler streams bounded text windows from sandboxed regular files.
 * Reads expose resumable line or byte coordinates and an opaque file revision.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  type ActionResult,
  buildReadView,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  capTranscriptForChat,
  failureToActionResult,
  fencePreformatted,
  readNumberParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { resolveInputPath } from "../lib/path-utils.js";
import type { FileStateService } from "../services/file-state-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import {
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

const BUFFER_BYTES = 64 * 1024;
const LINE_BUFFER_BYTES = 256;
type Unit = "line" | "byte";
type Window = {
  content: string;
  start: number;
  end: number;
  hasMore: boolean;
  total?: number;
  sourceBytesRead: number;
  nextByte?: number;
};

const lineCheckpoints = new Map<string, Map<number, number>>();

function revision(stat: Awaited<ReturnType<fs.FileHandle["stat"]>>): string {
  return createHash("sha256")
    .update(
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    )
    .digest("hex");
}

function integer(
  options: unknown,
  name: string,
  fallback: number,
): number | undefined {
  const value = readNumberParam(options, name) ?? fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function decode(bytes: Uint8Array): string {
  if (bytes.includes(0))
    throw new Error(
      "binary file detected; use SHELL+xxd or similar to inspect",
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("file is not valid UTF-8 text");
  }
}

function utf8SequenceLength(lead: number | undefined): number | undefined {
  if (lead === undefined) return undefined;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return undefined;
}

async function byteWindow(
  handle: fs.FileHandle,
  size: number,
  offset: number,
  limit: number,
): Promise<Window> {
  if (offset >= size)
    return {
      content: "",
      start: size,
      end: size,
      hasMore: false,
      total: size,
      sourceBytesRead: 0,
    };
  const requested = Math.min(limit, size - offset);
  const buffer = Buffer.allocUnsafe(requested + 3);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
  const available = buffer.subarray(0, bytesRead);
  if (offset > 0 && (available[0] & 0xc0) === 0x80)
    throw new Error(`byte offset ${offset} is not a UTF-8 character boundary`);
  let end = requested;
  let content: string | undefined;
  const shortestCandidate = Math.max(1, requested - 3);
  while (end >= shortestCandidate) {
    try {
      content = decode(available.subarray(0, end));
      if (end < requested) {
        const sequenceLength = utf8SequenceLength(available[end]);
        if (
          sequenceLength === undefined ||
          end + sequenceLength > available.length
        ) {
          content = undefined;
          break;
        }
        decode(available.subarray(end, end + sequenceLength));
      }
      break;
    } catch {
      end -= 1;
    }
  }
  if (content === undefined) {
    throw new Error(
      `byte limit ${limit} cannot produce a valid UTF-8 page at this offset`,
    );
  }
  return {
    content: content ?? "",
    start: offset,
    end: offset + end,
    hasMore: offset + end < size,
    total: size,
    sourceBytesRead: bytesRead,
  };
}

async function lineWindow(
  handle: fs.FileHandle,
  size: number,
  offset: number,
  limit: number,
  maxBytes: number,
  startByte: number,
  startLine: number,
): Promise<Window> {
  let position = startByte,
    line = startLine,
    endLine = offset,
    sourceBytesRead = 0;
  const parts: Buffer[] = [];
  let selectedBytes = 0,
    done = false,
    endedWithNewline = false;
  while (!done && position < size) {
    const buffer = Buffer.allocUnsafe(
      Math.min(LINE_BUFFER_BYTES, size - position),
    );
    const result = await handle.read(buffer, 0, buffer.length, position);
    if (!result.bytesRead) break;
    sourceBytesRead += result.bytesRead;
    const chunk = buffer.subarray(0, result.bytesRead);
    if (chunk.includes(0))
      throw new Error(
        "binary file detected; use SHELL+xxd or similar to inspect",
      );
    let segment = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 10) continue;
      if (line >= offset && line < offset + limit) {
        const part = chunk.subarray(segment, i + 1);
        selectedBytes += part.length;
        if (selectedBytes > maxBytes)
          throw new Error(
            `line window exceeds ${maxBytes} bytes; retry with unit=byte`,
          );
        parts.push(part);
        endLine = line + 1;
        endedWithNewline = true;
      }
      line += 1;
      segment = i + 1;
      if (line >= offset + limit) {
        position += i + 1;
        done = true;
        break;
      }
    }
    if (!done) {
      if (line >= offset && line < offset + limit && segment < chunk.length) {
        const part = chunk.subarray(segment);
        selectedBytes += part.length;
        if (selectedBytes > maxBytes)
          throw new Error(
            `line window exceeds ${maxBytes} bytes; retry with unit=byte`,
          );
        parts.push(part);
        endLine = line + 1;
        endedWithNewline = false;
      }
      position += result.bytesRead;
    }
  }
  const atEof = position >= size;
  const content = decode(Buffer.concat(parts, selectedBytes));
  return {
    content,
    start: offset,
    end: endLine,
    hasMore: !atEof,
    ...(atEof
      ? {
          total:
            startByte >= size
              ? startLine
              : size === 0
                ? 0
                : line + (endedWithNewline ? 0 : 1),
        }
      : {}),
    sourceBytesRead,
    nextByte: position,
  };
}

export async function readFileHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const conversationId =
    message.roomId == null ? undefined : String(message.roomId);
  if (!conversationId)
    return failureToActionResult({
      reason: "missing_param",
      message: "no roomId",
    });
  const filePath = readStringParam(options, "file_path");
  if (!filePath)
    return failureToActionResult({
      reason: "missing_param",
      message: "file_path is required",
    });
  const input = resolveInputPath(runtime, conversationId, filePath);
  if (!input.ok) return failureToActionResult(input.failure);
  const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
    typeof SandboxService
  > | null;
  const fileState = runtime.getService(FILE_STATE_SERVICE) as InstanceType<
    typeof FileStateService
  > | null;
  if (!sandbox || !fileState)
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools services unavailable",
    });
  const checked = await sandbox.validatePath(conversationId, input.value);
  if (!checked.ok)
    return failureToActionResult({
      reason: checked.reason === "blocked" ? "path_blocked" : "invalid_param",
      message: checked.message,
    });
  const rawUnit = readStringParam(options, "unit") ?? "line";
  if (rawUnit !== "line" && rawUnit !== "byte")
    return failureToActionResult({
      reason: "invalid_param",
      message: "unit must be line or byte",
    });
  const unit: Unit = rawUnit;
  const offset = integer(options, "offset", 0);
  const defaultLimit =
    unit === "line"
      ? readPositiveIntSetting(runtime, "CODING_TOOLS_MAX_READ_LINES", 2_000)
      : BUFFER_BYTES;
  const limit = integer(options, "limit", defaultLimit);
  if (offset === undefined || limit === undefined || limit === 0)
    return failureToActionResult({
      reason: "invalid_param",
      message:
        "offset must be non-negative and limit must be positive safe integers",
    });
  const maxBytes = readPositiveIntSetting(
    runtime,
    "CODING_TOOLS_MAX_FILE_SIZE_BYTES",
    262_144,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(checked.resolved, "r");
    const before = await handle.stat();
    if (!before.isFile())
      return failureToActionResult({
        reason: "invalid_param",
        message: "path is not a regular file",
      });
    const currentRevision = revision(before);
    const expected = readStringParam(options, "expectedRevision");
    if (offset > 0 && !expected)
      return failureToActionResult({
        reason: "invalid_param",
        message:
          "expectedRevision is required when continuing from a nonzero offset",
      });
    if (expected && expected !== currentRevision)
      return failureToActionResult(
        {
          reason: "stale_read",
          message: `expected revision ${expected} but found ${currentRevision}`,
        },
        { revision: currentRevision },
      );
    const checkpointKey = `${checked.resolved}\0${currentRevision}`;
    let checkpoints = lineCheckpoints.get(checkpointKey);
    if (!checkpoints) {
      checkpoints = new Map([[0, 0]]);
      lineCheckpoints.set(checkpointKey, checkpoints);
      if (lineCheckpoints.size > 64) {
        const oldest = lineCheckpoints.keys().next().value;
        if (oldest !== undefined) lineCheckpoints.delete(oldest);
      }
    }
    let checkpointLine = 0;
    let checkpointByte = 0;
    if (unit === "line") {
      for (const [candidateLine, candidateByte] of checkpoints) {
        if (candidateLine <= offset && candidateLine >= checkpointLine) {
          checkpointLine = candidateLine;
          checkpointByte = candidateByte;
        }
      }
    }
    const window =
      unit === "byte"
        ? await byteWindow(
            handle,
            before.size,
            offset,
            Math.min(limit, maxBytes),
          )
        : await lineWindow(
            handle,
            before.size,
            offset,
            limit,
            maxBytes,
            checkpointByte,
            checkpointLine,
          );
    if (unit === "line" && window.nextByte !== undefined) {
      checkpoints.set(window.end, window.nextByte);
    }
    if (
      unit === "line" &&
      window.total !== undefined &&
      offset > window.total
    ) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `line offset ${offset} exceeds total ${window.total}`,
      });
    }
    const afterRevision = revision(await handle.stat());
    if (afterRevision !== currentRevision)
      return failureToActionResult(
        {
          reason: "stale_read",
          message:
            "file changed while it was being read; retry from the new revision",
        },
        { revision: afterRevision },
      );
    const text = window.content;
    const sliceSha256 = createHash("sha256").update(text).digest("hex");
    const opaqueRef = `file:${createHash("sha256").update(checked.resolved).digest("hex")}`;
    const readView = buildReadView({
      reference: { kind: "file", ref: opaqueRef, revision: currentRevision },
      slice: {
        range: {
          unit,
          start: window.start,
          end: window.end,
          ...(window.total === undefined ? {} : { total: window.total }),
        },
        hasPrevious: window.start > 0,
        hasMore: window.hasMore,
        ...(window.hasMore ? { nextOffset: window.end } : {}),
        revision: currentRevision,
        completeness: window.hasMore ? "partial-recoverable" : "complete",
        sliceSha256,
        ...(!window.hasMore && window.start === 0
          ? { sourceSha256: sliceSha256 }
          : {}),
      },
    });
    await fileState.recordRead(conversationId, checked.resolved);
    logger.debug(
      `${CODING_TOOLS_LOG_PREFIX} READ ${checked.resolved} unit=${unit} offset=${offset} end=${window.end} sourceBytesRead=${window.sourceBytesRead}`,
    );
    if (callback)
      await callback({
        text: fencePreformatted(capTranscriptForChat(text)),
        source: "coding-tools",
      });
    return {
      ...successActionResult(text, {
        readView,
        diagnostics: {
          sourceBytesRead: window.sourceBytesRead,
          bytesReturned: Buffer.byteLength(window.content),
        },
      }),
      promptData: { readView },
    };
  } catch (error) {
    // error-policy:J1 action boundary; read failures become explicit failure results.
    return failureToActionResult({
      reason: "io_error",
      message: `read failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    await handle?.close().catch(() => {
      /* error-policy:J6 best-effort descriptor teardown. */
    });
  }
}
