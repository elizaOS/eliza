import type { NativeToolCallEvent } from "../../api/client-types-cloud";
export interface ToolCallEventLogProps {
  event: NativeToolCallEvent;
  className?: string;
}
export type ToolCallEventDisplayState = "running" | "success" | "failure";
export declare function getToolCallEventDisplayState(
  event: NativeToolCallEvent,
): ToolCallEventDisplayState;
export declare function getToolCallName(event: NativeToolCallEvent): string;
export declare function ToolCallEventLog({
  className,
  event,
}: ToolCallEventLogProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ToolCallEventLog.d.ts.map
