/**
 * Chat text normalization helpers.
 *
 * Shared between server.ts and chat-routes.ts. Re-exports stage-direction
 * stripping from core and provides no-response detection helpers.
 */

import { stripAssistantStageDirections } from "@elizaos/core";

export { stripAssistantStageDirections };

export function isNoResponsePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed);
}

export function isClientVisibleNoResponse(text: string): boolean {
  if (isNoResponsePlaceholder(text)) return true;
  return isNoResponsePlaceholder(stripAssistantStageDirections(text));
}
