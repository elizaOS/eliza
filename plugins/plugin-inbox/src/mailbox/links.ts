/** Inert handling of links found in mail: validated data, never fetched or rendered as HTML. */
import type { GmailLink } from "./types.ts";

/** Only absolute http(s) links without credentials are kept; anything else is dropped as untrusted. */
export function safeMailLink(value: unknown): GmailLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.href !== "string" ||
    row.href.length > 2048 ||
    typeof row.text !== "string"
  )
    return null;
  let url: URL;
  try {
    url = new URL(row.href);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    !url.hostname
  )
    return null;
  const text = row.text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from untrusted labels.
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return { href: url.href, text: text || url.hostname };
}

/** Plain-text https URLs in a message body, trimmed of trailing punctuation. Nothing is fetched. */
export function linkifyMailText(text: string): GmailLink[] {
  const links: GmailLink[] = [],
    seen = new Set<string>();
  for (const match of String(text || "").matchAll(/https:\/\/[^\s<>"'`]+/gi)) {
    // Trailing punctuation is trimmed in one linear pass (hostile bodies may end
    // a URL with a long run of ")"); a ")" stays while it closes a "(" in the URL.
    const raw = match[0];
    let end = raw.length,
      open = 0,
      close = 0;
    for (const c of raw) {
      if (c === "(") open++;
      else if (c === ")") close++;
    }
    while (end > 0 && ".,;:!?)]}>".includes(raw[end - 1] as string)) {
      if (raw[end - 1] === ")") {
        if (open >= close) break;
        close--;
      }
      end--;
    }
    const link = safeMailLink({
      href: raw.slice(0, end),
      text: raw.slice(0, end),
    });
    if (link && !seen.has(link.href)) {
      seen.add(link.href);
      links.push(link);
    }
    if (links.length >= 50) break;
  }
  return links;
}

/** The link text names a different site than the destination (a common phishing pattern). */
export function linkTextMismatch(link: GmailLink): boolean {
  let host: string;
  try {
    host = new URL(link.href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return true;
  }
  const named = link.text
    .toLowerCase()
    .match(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,63})(?=[/:\s]|$)/);
  if (!named) return false;
  const shown = (named[1] as string).replace(/^www\./, "");
  return shown !== host && !host.endsWith(`.${shown}`);
}
