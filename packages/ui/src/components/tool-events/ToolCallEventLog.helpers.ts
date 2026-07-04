/**
 * Pure derivations for `ToolCallEventLog`: maps a `NativeToolCallEvent` to its
 * running/success/failure display state and resolves a human-readable tool name
 * from whichever of the event's name/id fields is populated. Kept
 * component-free so the mapping can be unit-tested without a DOM.
 */
import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import type { ToolCallEventDisplayState } from "./ToolCallEventLog";

export function getToolCallEventDisplayState(
  event: NativeToolCallEvent,
): ToolCallEventDisplayState {
  if (event.type === "tool_error" || event.status === "failed" || event.error) {
    return "failure";
  }
  if (
    event.type === "tool_result" ||
    event.status === "completed" ||
    event.success === true
  ) {
    return "success";
  }
  return "running";
}

export function getToolCallName(event: NativeToolCallEvent): string {
  return (
    event.actionName ||
    event.toolName ||
    event.name ||
    event.callId ||
    event.toolCallId ||
    "tool"
  );
}
