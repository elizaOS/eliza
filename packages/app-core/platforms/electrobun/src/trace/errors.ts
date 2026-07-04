/** Implements Electrobun desktop errors ts behavior for app-core shell integration. */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";

export type TraceErrorCode =
  | "TRACE_INVALID_REQUEST"
  | "TRACE_SESSION_NOT_FOUND"
  | "TRACE_SESSION_CLOSED"
  | "TRACE_VIEW_UNAVAILABLE"
  | "TRACE_VIEW_OPEN_FAILED"
  | "TRACE_VIEW_PUSH_FAILED";

export class TraceError extends Error {
  readonly code: TraceErrorCode;
  readonly details?: JsonValue;

  constructor(code: TraceErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "TraceError";
    this.code = code;
    this.details = details;
  }
}
