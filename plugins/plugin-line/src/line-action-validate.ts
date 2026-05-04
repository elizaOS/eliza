import type { Memory } from "@elizaos/core";

/**
 * Shared gate for LINE outbound actions: keyword hints, intent pattern, LINE source, and usable content.
 */
export function isLineOutboundActionContext(
  message: Memory,
  keywords: readonly string[],
  intentPattern: RegExp
): boolean {
  const textRaw = typeof message.content?.text === "string" ? message.content.text : "";
  const textLower = textRaw.toLowerCase();
  const mentionsKeyword = keywords.some((kw) => kw.length > 0 && textLower.includes(kw));
  const matchesIntent = intentPattern.test(textLower);
  const fromLineChannel = message.content?.source === "line";
  const hasUsableContent =
    textRaw.trim().length > 0 || Boolean(message.content && typeof message.content === "object");
  return mentionsKeyword && matchesIntent && fromLineChannel && hasUsableContent;
}
