import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { SignalService } from "../service";
import { SIGNAL_SERVICE_NAME } from "../types";

function contentRecord(message: Memory): Record<string, unknown> {
  return message.content as Record<string, unknown>;
}

export function getSignalService(runtime: IAgentRuntime): SignalService | null {
  return runtime.getService(SIGNAL_SERVICE_NAME) as SignalService | null;
}

export function hasSignalService(runtime: IAgentRuntime): boolean {
  return Boolean(getSignalService(runtime));
}

export function isSignalConversation(message: Memory): boolean {
  return message.content.source === "signal";
}

export function getMessageText(message: Memory): string {
  return typeof message.content.text === "string" ? message.content.text.trim() : "";
}

export function hasStructuredSignalInvocation(
  message: Memory,
  actionName: string,
  structuredKeys: string[] = []
): boolean {
  const content = contentRecord(message);
  const actions = Array.isArray(content.actions) ? content.actions : [];

  if (actions.includes(actionName)) {
    return true;
  }

  return structuredKeys.some((key) => {
    const value = content[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}
