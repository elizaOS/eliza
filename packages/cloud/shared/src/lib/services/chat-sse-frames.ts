/**
 * Canonical SSE chat-frame construction for every Cloud chat producer: the
 * shared runtime, the sandbox and its bridge, and the control-plane fallback.
 * Each frame keeps its legacy named `event:` line for consumers that dispatch
 * on it while stamping the additive JSON `type` the shared UI client
 * classifies on, so a terminal `done` or `error` frame can never be misread as
 * another token by a client that ignores SSE event names (#17122). The
 * canonical `type` is written last so no payload field can override it.
 */

export type ChatSseEventName = "chunk" | "done" | "error";

/** Terminal fields understood by the shared UI stream reducer. */
const DONE_METADATA_FIELDS = [
  "transcriptVisibility",
  "agentName",
  "userMessageId",
  "assistantEphemeral",
  "historyRefreshRequired",
  "thought",
  "noResponseReason",
  "failureKind",
  "accountConnect",
  "localInference",
  "actionResults",
  "usage",
] as const;

const EVENT_JSON_TYPE = {
  chunk: "token",
  done: "done",
  error: "error",
} as const satisfies Record<ChatSseEventName, string>;

export function chatSseFrame(event: ChatSseEventName, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({
    ...payload,
    type: EVENT_JSON_TYPE[event],
  })}\n\n`;
}

/**
 * Normalizes a dedicated-agent terminal event without dropping planner or
 * persistence metadata. Only fields consumed by the shared client cross this
 * proxy boundary; arbitrary upstream properties are intentionally excluded.
 */
export function normalizeChatSseDonePayload(
  payload: Record<string, unknown>,
  fallback: { messageId: string; fullText: string },
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const field of DONE_METADATA_FIELDS) {
    if (Object.hasOwn(payload, field)) normalized[field] = payload[field];
  }

  const upstreamMessageId = payload.messageId;
  normalized.messageId =
    typeof upstreamMessageId === "string" && upstreamMessageId.trim()
      ? upstreamMessageId
      : fallback.messageId;

  const fullText =
    typeof payload.fullText === "string"
      ? payload.fullText
      : typeof payload.text === "string"
        ? payload.text
        : fallback.fullText;
  normalized.text = fullText;
  normalized.fullText = fullText;
  return normalized;
}
