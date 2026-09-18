/**
 * Chat text normalization helpers.
 *
 * Shared between server.ts and chat-routes.ts. Re-exports canonical
 * stage-direction stripping from @elizaos/shared and provides no-response detection.
 */

import { stripAssistantStageDirections } from "@elizaos/shared";

export { stripAssistantStageDirections };

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

export function isNoResponsePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed);
}

export function isClientVisibleNoResponse(text: string): boolean {
  if (isNoResponsePlaceholder(text)) return true;
  return isNoResponsePlaceholder(stripAssistantStageDirections(text));
}
