// How a spec's lines and any source text are read: shared by the parser (parse.ts) and the studio's page, so it imports nothing.

/** What one line of a spec is: a story or rule heading, a fence that opens or closes, a line inside a fence, or prose. */
export type LineKind = "story" | "rule" | "open" | "open quint" | "close" | "quint" | "fenced" | "prose";

/**
 * Every line of a spec with what it is. A fence of any kind (``` or ~~~, of any length) closes only with a fence of
 * the same character at least as long and nothing after it; `##` and `###` inside a fence are not headings.
 */
export function scanSpec(text: string): { text: string; kind: LineKind }[] {
  let fence: { mark: string; quint: boolean } | undefined;
  return text.split("\n").map((text) => {
    const marker = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence && marker && marker[1][0] === fence.mark[0] && marker[1].length >= fence.mark.length && !marker[2].trim()) {
      fence = undefined;
      return { text, kind: "close" };
    }
    if (fence) return { text, kind: fence.quint ? "quint" : "fenced" };
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = { mark: marker[1], quint: marker[2].trim().split(/\s+/)[0] === "quint" };
      return { text, kind: fence.quint ? "open quint" : "open" };
    }
    return { text, kind: text.startsWith("## ") ? "story" : text.startsWith("### ") ? "rule" : "prose" };
  });
}

/**
 * `text` with `\r\n` read as `\n`, or a refusal naming the file and line if it holds NUL or a line break other than
 * `\n`. Quint, TypeScript, Dafny and these tools do not all agree on where a line ends at `\r`, `\v`, `\f`, U+0085,
 * U+2028 or U+2029, so a reviewer could see lines that differ from what a compiler reads, and prose could end a
 * comment early. No source needs NUL.
 */
export function plainText(file: string, text: string): string {
  const plain = text.replace(/\r\n/g, "\n");
  const lineOf = (at: number) => plain.slice(0, at).split("\n").length;
  const nul = plain.indexOf("\0");
  if (nul >= 0) throw new Error(`${file}:${lineOf(nul)}: NUL characters are not allowed`);
  const odd = plain.search(/[\r\v\f\u0085\u2028\u2029]/);
  if (odd >= 0) throw new Error(`${file}:${lineOf(odd)}: a line break other than \\n; save the file with plain line endings`);
  return plain;
}
