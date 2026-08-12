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
