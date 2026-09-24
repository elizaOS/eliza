/**
 * Frames host chat responses as server-sent events over Node HTTP.
 * Legacy and delta protocols retain their negotiated token, snapshot and
 * provisional semantics. Turn admission and durable delivery remain with routes.
 */
import type http from "node:http";
import { type ChatToolCallEvent, type ChatTurnStatus } from "@elizaos/core/contracts/chat";
import { DELTA_STREAM_PROTOCOL } from "@elizaos/ui/utils/streaming-text";

export function initSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function writeSse(
  res: http.ServerResponse,
  payload: Record<string, unknown>,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeChatTokenSse(
  res: http.ServerResponse,
  text: string,
  fullText: string,
  options?: ChatTokenWriteOptions,
): void {
  writeSse(res, {
    type: "token",
    text,
    fullText,
    ...(options?.provisional ? { provisional: true } : {}),
  });
}

export { DELTA_STREAM_PROTOCOL };

export type ChatTokenStreamProtocol = "legacy" | typeof DELTA_STREAM_PROTOCOL;

/**
 * Transport writers supplied by the caller so token framing can share the
 * caller's delivery boundary.
 */
export interface ChatTokenStreamWriterDeps {
  writeChatTokenSse: typeof writeChatTokenSse;
  writeSse: typeof writeSse;
}

/**
 * Per-write options for the token wire. `provisional: true` marks the carried
 * text as an in-flight action-callback delivery the turn's final reply may
 * replace — voice clients must not synthesize it until the terminal `done`
 * frame (or a later non-provisional frame) confirms it, because speech cannot
 * be retracted the way a re-rendered chat bubble can (the "double-speak"
 * defect). Text bubbles may render it exactly as before.
 */
export interface ChatTokenWriteOptions {
  provisional?: boolean;
}

export interface ChatTokenStreamWriter {
  /** An incremental streamed chunk. `fullText` is the accumulated text so far. */
  writeChunk(
    res: http.ServerResponse,
    chunk: string,
    fullText: string,
    options?: ChatTokenWriteOptions,
  ): void;
  /** An authoritative full-text replace (structured-field rewrite, single-frame
   *  reply). The client treats the carried `fullText` as the new buffer. */
  writeSnapshot(
    res: http.ServerResponse,
    fullText: string,
    options?: ChatTokenWriteOptions,
  ): void;
}

/**
 * Framing-agnostic front for the streaming chat token wire. `legacy` reproduces
 * the historical per-token `{text, fullText}` frame byte-for-byte; `delta-v2`
 * ships bare `{text}` deltas and re-sends the accumulated `fullText` only on a
 * geometric UTF-16 code-unit budget, so an M-chunk reply carries O(N) bytes instead of the
 * legacy O(N²) (every token re-serialized its whole prefix). The protocol is
 * negotiated per request (see `readChatRequestPayload`).
 */
export function createChatTokenStreamWriter(
  protocol: ChatTokenStreamProtocol,
  deps: ChatTokenStreamWriterDeps,
): ChatTokenStreamWriter {
  const provisionalField = (options?: ChatTokenWriteOptions) =>
    options?.provisional ? { provisional: true as const } : {};
  if (protocol === "legacy") {
    return {
      writeChunk(res, chunk, fullText, options) {
        deps.writeChatTokenSse(res, chunk, fullText, options);
      },
      writeSnapshot(res, fullText, options) {
        deps.writeChatTokenSse(res, fullText, fullText, options);
      },
    };
  }

  // Snapshot spacing grows with the previous full text's UTF-16 length.
  // The 2048-unit floor permits recovery snapshots on short replies while
  // geometric spacing keeps total wire size linear for long replies.
  let bytesSinceSnapshot = 0;
  let lengthAtLastSnapshot = 0;
  return {
    writeChunk(res, chunk, fullText, options) {
      bytesSinceSnapshot += chunk.length;
      if (bytesSinceSnapshot >= Math.max(2048, lengthAtLastSnapshot)) {
        deps.writeSse(res, {
          type: "token",
          text: chunk,
          fullText,
          ...provisionalField(options),
        });
        bytesSinceSnapshot = 0;
        lengthAtLastSnapshot = fullText.length;
      } else {
        deps.writeSse(res, {
          type: "token",
          text: chunk,
          ...provisionalField(options),
        });
      }
    },
    writeSnapshot(res, fullText, options) {
      // No `text` field: the client reads `fullText` as an authoritative
      // replace rather than an append.
      deps.writeSse(res, {
        type: "token",
        fullText,
        ...provisionalField(options),
      });
      bytesSinceSnapshot = 0;
      lengthAtLastSnapshot = fullText.length;
    },
  };
}

export function writeChatStatusSse(
  res: http.ServerResponse,
  status: ChatTurnStatus,
): void {
  writeSse(res, { type: "status", ...status });
}

export function writeChatToolSse(
  res: http.ServerResponse,
  event: ChatToolCallEvent,
): void {
  writeSse(res, { type: "tool", ...event });
}

export function writeSseData(
  res: http.ServerResponse,
  data: string,
  event?: string,
): void {
  if (res.writableEnded || res.destroyed) return;
  const safeEvent =
    typeof event === "string" && /^[A-Za-z0-9_.-]+$/.test(event) ? event : null;
  if (safeEvent) res.write(`event: ${safeEvent}\n`);
  for (const line of data.split(/\r\n|\r|\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

export function writeSseJson(
  res: http.ServerResponse,
  payload: unknown,
  event?: string,
): void {
  writeSseData(res, JSON.stringify(payload), event);
}
