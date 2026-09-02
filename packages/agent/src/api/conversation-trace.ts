/**
 * Resolves the bounded correlation identifier for an inbound conversation turn.
 * Caller-controlled values are adopted only when they match the inference
 * timer's closed 32-lowercase-hex schema; every other shape is discarded.
 */

import type http from "node:http";
import { isInferenceTraceId, mintInferenceTraceId } from "@elizaos/core";

export const ELIZA_TRACE_ID_HEADER = "X-Eliza-Trace-Id";

export interface ConversationTraceContext {
  readonly traceId: string;
  readonly source: "inbound" | "minted";
}

/** Adopt a valid inbound id or mint a new one without retaining invalid text. */
export function resolveConversationTraceContext(
  headers: http.IncomingHttpHeaders,
): ConversationTraceContext {
  const supplied = headers[ELIZA_TRACE_ID_HEADER.toLowerCase()];
  if (isInferenceTraceId(supplied)) {
    return { traceId: supplied, source: "inbound" };
  }
  return { traceId: mintInferenceTraceId(), source: "minted" };
}
