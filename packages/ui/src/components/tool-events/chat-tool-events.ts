/**
 * Folds the chat SSE's inline tool-call events (the additive `type: "tool"`
 * frames, `ChatToolCallEvent`) into the `NativeToolCallEvent` shape the
 * `ToolCallEventLog` row already renders — so the chat thread reuses the same
 * tool-row component as the trajectory inspector (#13535). A `call` is matched
 * to its later `result`/`error` by `callId` and updated in place, so one row
 * flips running → success/failure rather than appending a duplicate.
 */
import type { ChatToolCallEvent } from "../../api/client-types-chat";
import type { NativeToolCallEvent } from "../../api/client-types-cloud";

function toNativeToolCallEvent(event: ChatToolCallEvent): NativeToolCallEvent {
  return {
    id: event.callId,
    callId: event.callId,
    toolName: event.toolName,
    type:
      event.phase === "call"
        ? "tool_call"
        : event.phase === "error"
          ? "tool_error"
          : "tool_result",
    status:
      event.phase === "call"
        ? "running"
        : event.phase === "error"
          ? "failed"
          : "completed",
    ...(event.args ? { args: event.args } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

export function mergeChatToolEvent(
  events: readonly NativeToolCallEvent[],
  event: ChatToolCallEvent,
): NativeToolCallEvent[] {
  const next = toNativeToolCallEvent(event);
  const index = events.findIndex(
    (existing) => existing.callId === event.callId,
  );
  if (index === -1) return [...events, next];
  // Merge onto the existing row so the `call`'s args survive into the settled
  // `result`/`error` render.
  const merged = { ...events[index], ...next };
  const copy = events.slice();
  copy[index] = merged;
  return copy;
}
