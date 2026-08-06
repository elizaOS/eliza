/**
 * Syntax highlighting worker.
 * Loads Shiki lazily on first use so the main thread never blocks on it.
 *
 * Message in:  { id: string; code: string; lang: string; theme?: string }
 * Message out: { id: string; html: string; plainText: string }
 */

import type { Highlighter } from "shiki";

interface InMessage {
  id: string;
  code: string;
  lang: string;
  theme?: string;
}

interface OutMessage {
  id: string;
  html: string;
  plainText: string;
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [
          "typescript",
          "javascript",
          "tsx",
          "jsx",
          "python",
          "bash",
          "shell",
          "json",
          "yaml",
          "markdown",
          "css",
          "html",
          "rust",
          "go",
          "java",
          "c",
          "cpp",
          "sql",
          "dockerfile",
        ],
      })
    );
  }
  return highlighterPromise;
}

async function highlight(msg: InMessage): Promise<OutMessage> {
  const highlighter = await getHighlighter();
  const theme = msg.theme ?? "github-dark";

  let html: string;
  try {
    html = highlighter.codeToHtml(msg.code, { lang: msg.lang, theme });
  } catch {
    // Unknown language — fall back to plain text rendering
    html = highlighter.codeToHtml(msg.code, { lang: "text", theme });
  }

  return { id: msg.id, html, plainText: msg.code };
}

self.addEventListener("message", async (e: MessageEvent<InMessage>) => {
  const result = await highlight(e.data);
  self.postMessage(result);
});
