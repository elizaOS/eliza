/**
 * Markdown parsing worker.
 * Receives raw markdown strings and returns parsed token arrays
 * so the main thread can skip heavy parsing during rendering.
 *
 * Message in:  { id: string; markdown: string }
 * Message out: { id: string; html: string }
 *
 * NOTE: This worker intentionally avoids importing the full remark
 * pipeline to keep its bundle small. It does lightweight pre-processing
 * (sanitise, extract headings/code-fence metadata) that would otherwise
 * block the main thread on large documents.
 */

interface InMessage {
  id: string;
  markdown: string;
}

interface OutMessage {
  id: string;
  /** Line-by-line token classification for incremental rendering */
  tokens: TokenLine[];
  /** Top-level headings extracted for a mini table-of-contents */
  headings: { level: number; text: string }[];
  /** Number of code blocks found */
  codeBlockCount: number;
}

interface TokenLine {
  type: "text" | "heading" | "code-fence" | "list-item" | "blockquote" | "hr" | "blank";
  content: string;
  level?: number; // heading level
  lang?: string;  // code fence language
}

function classifyLine(line: string): TokenLine {
  if (line.trim() === "") return { type: "blank", content: "" };
  if (/^#{1,6}\s/.test(line)) {
    const level = (line.match(/^(#{1,6})\s/)![1].length) as number;
    return { type: "heading", content: line.replace(/^#{1,6}\s+/, ""), level };
  }
  if (/^```/.test(line)) {
    const lang = line.slice(3).trim() || undefined;
    return { type: "code-fence", content: line, lang };
  }
  if (/^[-*+]\s|^\d+\.\s/.test(line)) return { type: "list-item", content: line };
  if (/^>\s/.test(line)) return { type: "blockquote", content: line.slice(2) };
  if (/^[-*_]{3,}$/.test(line.trim())) return { type: "hr", content: line };
  return { type: "text", content: line };
}

function process(msg: InMessage): OutMessage {
  const lines = msg.markdown.split("\n");
  const tokens: TokenLine[] = lines.map(classifyLine);
  const headings = tokens
    .filter((t): t is TokenLine & { type: "heading" } => t.type === "heading")
    .map((t) => ({ level: t.level!, text: t.content }));
  const codeBlockCount = tokens.filter((t) => t.type === "code-fence").length;

  return { id: msg.id, tokens, headings, codeBlockCount };
}

self.addEventListener("message", (e: MessageEvent<InMessage>) => {
  self.postMessage(process(e.data));
});
