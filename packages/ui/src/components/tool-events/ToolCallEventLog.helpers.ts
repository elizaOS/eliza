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
