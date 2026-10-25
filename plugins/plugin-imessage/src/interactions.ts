/**
 * Text-only projection for interaction blocks sent through iMessage.
 *
 * Messages.app has no structured button or form primitive for agent replies, so
 * outbound content strips bracket markers and appends concise prose fallbacks
 * before the normal iMessage chunking step. Keeping this as a pure helper lets
 * the send handler and inbound reply callback share the same transport-safe
 * rendering.
 */

import {
  buildInteractionUrlResolver,
  type Content,
  renderContentInteractionsAsPlainText,
} from "@elizaos/core";

export function renderIMessageInteractionText(content: Content, appBaseUrl?: string): string {
  return renderContentInteractionsAsPlainText(content, buildInteractionUrlResolver(appBaseUrl))
    .text;
}
