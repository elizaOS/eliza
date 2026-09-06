/**
 * Recovers the user's request from a chat message text that document
 * augmentation wrapped in its instruction preamble. Dependency-free so
 * providers and gates can use it without importing the API route module.
 */

const USER_REQUEST_BLOCK = /<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$/;

/**
 * Text produced by `maybeAugmentChatMessageWithDocuments` carries the user's
 * words in a trailing `<user_request>` block; relevance and detection gates
 * that run after augmentation must score that request, not the wrapper
 * (live 2026-09-06: the wrapper's own words matched a recall keyword on every
 * API turn). Text without the wrapper is returned unchanged.
 */
export function userRequestFromAugmentedText(text: string): string {
  const match = USER_REQUEST_BLOCK.exec(text);
  return match ? match[1].trim() : text;
}
