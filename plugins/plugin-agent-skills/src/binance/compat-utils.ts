/**
 * Content-text extraction shared by the Binance direct-skill fast path.
 *
 * Normalizes the several shapes a message `content` can take (raw string,
 * text-part array, or `{ text }` object) into a single string.
 */

export function extractCompatTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      if (type && type !== "text") continue;
      if (typeof obj.text === "string" && obj.text) chunks.push(obj.text);
    }
    return chunks.join("");
  }
  if (content && typeof content === "object") {
    const text = (content as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}
