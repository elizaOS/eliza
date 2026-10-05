/**
 * Frames host chat responses as server-sent events over Node HTTP.
 * Delta chunks, recovery snapshots and provisional status share one protocol.
 * Turn admission and durable delivery remain with routes.
 */
import type http from "node:http";
import type { ChatToolCallEvent, ChatTurnStatus } from "@elizaos/contracts";

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

/** Emits deltas with geometrically spaced recovery snapshots. */
export function createChatTokenStreamWriter(): ChatTokenStreamWriter {
  const provisionalField = (options?: ChatTokenWriteOptions) =>
    options?.provisional ? { provisional: true as const } : {};
  // Snapshot spacing grows with the previous full text's UTF-16 length.
  // The 2048-unit floor permits recovery snapshots on short replies while
  // geometric spacing keeps total wire size linear for long replies.
  let bytesSinceSnapshot = 0;
  let lengthAtLastSnapshot = 0;
  return {
    writeChunk(res, chunk, fullText, options) {
      bytesSinceSnapshot += chunk.length;
      if (bytesSinceSnapshot >= Math.max(2048, lengthAtLastSnapshot)) {
        writeSse(res, {
          type: "token",
          text: chunk,
          fullText,
          ...provisionalField(options),
        });
        bytesSinceSnapshot = 0;
        lengthAtLastSnapshot = fullText.length;
      } else {
        writeSse(res, {
          type: "token",
          text: chunk,
          ...provisionalField(options),
        });
      }
    },
    writeSnapshot(res, fullText, options) {
      // No `text` field: the client reads `fullText` as an authoritative
      // replace rather than an append.
      writeSse(res, {
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
