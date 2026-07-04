/**
 * Builds the ActionResult for the "no suitable tool" outcome: replies to the user
 * that no MCP tool matched and falls back to direct assistance.
 */
import type { ActionResult, HandlerCallback } from "@elizaos/core";

interface ToolSelectionResult {
  readonly noToolAvailable?: boolean;
  readonly reasoning?: string;
}

export async function handleNoToolAvailable(
  callback: HandlerCallback | undefined,
  toolSelection: ToolSelectionResult | null | undefined
): Promise<ActionResult> {
  const responseText =
    "I don't have a specific tool that can help with that request. Let me try to assist you directly instead.";

  if (callback && toolSelection?.noToolAvailable) {
    await callback({
      text: responseText,
      actions: ["REPLY"],
    });
  }

  return {
    text: responseText,
    values: {
      success: true,
      noToolAvailable: true,
      fallbackToDirectAssistance: true,
    },
    data: {
      actionName: "MCP",
      op: "call_tool",
      noToolAvailable: true,
      reason: toolSelection?.reasoning ?? "No appropriate tool available",
    },
    success: true,
  };
}
