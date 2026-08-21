/** Render only the small, safe Markdown-link subset used by chat receipts. */

import type { ReactNode } from "react";

function safeChatLinkTarget(raw: string): string | null {
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

export function SafeMarkdownText({ text }: { text: string }): ReactNode {
  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    const [raw, label, rawTarget] = match;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const target = safeChatLinkTarget(rawTarget);
    nodes.push(
      target ? (
        <a
          key={`link:${index}`}
          href={target}
          className="pointer-events-auto text-accent underline underline-offset-2"
        >
          {label}
        </a>
      ) : (
        raw
      ),
    );
    cursor = index + raw.length;
  }
  if (cursor === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
