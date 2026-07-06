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
  parseInteractionBlocks,
  toPlainTextFallback,
} from "@elizaos/core";

export function renderIMessageInteractionText(content: Content, appBaseUrl?: string): string {
  const text = typeof content.text === "string" ? content.text : "";
  const { blocks, cleanedText } = parseInteractionBlocks(text);
  if (blocks.length === 0) {
    return text;
  }

  const resolver = buildInteractionUrlResolver(appBaseUrl);
  const fallbackLines = blocks
    .map((block) => toPlainTextFallback(block, resolver))
    .filter((line): line is string => Boolean(line?.trim()));

  return [cleanedText, ...fallbackLines].filter((part) => part.trim().length > 0).join("\n\n");
}
