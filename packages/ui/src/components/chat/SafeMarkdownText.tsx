/** Render only the small, safe Markdown-link subset used by chat receipts. */

import type { MouseEvent, ReactNode } from "react";
import { dispatchNavigateViewEvent } from "../../events";

function safeChatLinkTarget(raw: string): string | null {
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

const LOCAL_APP_PREVIEW_PATH =
  /^\/api\/apps\/local\/[A-Za-z0-9._~%-]+\/(?:[?#].*)?$/;

export function appPreviewBrowserViewPath(
  target: string,
  origin: string,
): string | null {
  if (!LOCAL_APP_PREVIEW_PATH.test(target)) return null;
  try {
    const absoluteUrl = new URL(target, origin).toString();
    return `/browser?browse=${encodeURIComponent(absoluteUrl)}`;
  } catch {
    return null;
  }
}

function openAppPreviewInBrowserView(
  event: MouseEvent<HTMLAnchorElement>,
  target: string,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    typeof window === "undefined"
  ) {
    return;
  }
  const viewPath = appPreviewBrowserViewPath(target, window.location.origin);
  if (!viewPath) return;
  event.preventDefault();
  dispatchNavigateViewEvent({
    viewId: "browser",
    viewPath,
    viewLabel: "Browser",
    viewType: "gui",
    source: "user",
  });
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
          onClick={(event) => openAppPreviewInBrowserView(event, target)}
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
