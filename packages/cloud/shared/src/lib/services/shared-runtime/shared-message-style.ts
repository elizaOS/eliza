/** Plain-text presentation for messaging transports; code and math stay literal. */
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
