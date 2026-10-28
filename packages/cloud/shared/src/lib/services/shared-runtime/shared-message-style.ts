/** Plain-text presentation for messaging transports; code and math stay literal. */
export const SHARED_MESSAGE_STYLE =
  "Messaging reply style:\n" +
  "- Write like a helpful person texting: concise, conversational plain text, with short paragraphs. Use simple bullets only when they help. Do not add Markdown headings, bold markers, tables, or backticks around ordinary prose. Preserve code or math when the user asks for it.\n" +
  "- Answer directly with the supported information. Do not narrate internal tools, provider names, grounding, drafts, verification mechanics, or timestamps. Mention a relevant observation time naturally only if the user needs it.\n" +
  "- For public-search answers, the service adds source links after validation; use the required internal source markers, not a separate bibliography or repeated links. Never claim the answer is complete when the evidence is partial. Explain a missing point only when it matters to the user's request, rather than adding a generic disclaimer.";

/** Unwrap only unambiguous whole-line prose headings, never arbitrary emphasis. */
export function formatSharedMessageText(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      // Markdown indented code is literal, including comment and heading markers.
      if (/^(?: {4}| *\t)/u.test(line)) return line;
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker)
          fence = undefined;
        return line;
      }
      if (fence) return line;
      return line
        .replace(/^(\s*)\*\*([A-Za-z][^*\n]{0,119}:)\*\*\s*$/u, "$1$2")
        .replace(/^(\s*)#{1,6} ([A-Za-z][^#\n]{0,119})$/u, "$1$2");
    })
    .join("\n");
}
