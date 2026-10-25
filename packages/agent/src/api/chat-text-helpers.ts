/** Detect empty or suppressed assistant text for client delivery. */
import { stripAssistantStageDirections } from "@elizaos/core";

export function isNoResponsePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed);
}

export function isClientVisibleNoResponse(text: string): boolean {
  if (isNoResponsePlaceholder(text)) return true;
  return isNoResponsePlaceholder(stripAssistantStageDirections(text));
}
