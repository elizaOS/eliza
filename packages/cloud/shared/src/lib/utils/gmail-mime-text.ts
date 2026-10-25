// Pure helpers for Gmail API message payloads (users.messages.get format=full). No network,
// no HTML rendering: links are returned as inert data for clients to review before opening.

import {
  decodeGmailPartData,
  gmailPartCharset,
  MAX_GMAIL_MIME_NODES,
  WINDOWS_1252_HIGH,
} from "@elizaos/plugin-google-workspace/gmail-mime-parts";

export { decodeGmailPartData, gmailPartCharset };

export interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayloadPart[];
}

export interface GmailMessageLink {
  href: string;
  text: string;
}

/** Decodes one part's inline body with its own declared charset. */
export function decodeGmailPart(part: GmailPayloadPart, strict = false): string {
  return typeof part.body?.data === "string"
    ? decodeGmailPartData(part.body.data, gmailPartCharset(part), strict)
    : "";
}

/**
 * The decoded body of the first part with exactly `mimeType` in the subtree,
 * searching every multipart container before the caller moves on to the next
 * mime type. A container's own nested result must not preempt the caller's
 * preference order: a text/html part inside an early container is not the
 * text/plain body a later sibling part carries.
 */
function findGmailBodyByMime(payload: GmailPayloadPart, mimeType: string, depth: number): string {
  if (depth > 20) throw new Error("Gmail MIME nesting exceeds the supported depth");
  if (!Array.isArray(payload.parts)) return "";
  for (const part of payload.parts) {
    if (part?.mimeType === mimeType && typeof part.body?.data === "string")
      return decodeGmailPart(part);
    if (part?.mimeType?.startsWith("multipart/")) {
      const nested = findGmailBodyByMime(part, mimeType, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
}

/**
 * The first displayable body: the payload's own data, else text/plain then text/html among the
 * parts (recursing into multipart containers), each decoded with its declared charset.
 */
export function extractGmailBodyText(
  payload: GmailPayloadPart | null | undefined,
  depth = 0,
): string {
  if (!payload) return "";
  if (depth > 20) throw new Error("Gmail MIME nesting exceeds the supported depth");
  if (typeof payload.body?.data === "string") return decodeGmailPart(payload);
  if (!Array.isArray(payload.parts)) return "";
  for (const mimeType of ["text/plain", "text/html"]) {
    const found = findGmailBodyByMime(payload, mimeType, depth);
    if (found) return found;
  }
  for (const part of payload.parts) {
    const nested = extractGmailBodyText(part, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function walk(payload: GmailPayloadPart, visit: (part: GmailPayloadPart) => void): void {
  let visited = 0;
  const step = (part: GmailPayloadPart) => {
    if (++visited > MAX_GMAIL_MIME_NODES)
      throw new Error("Gmail message exceeds the MIME part limit");
    if (!part || typeof part !== "object") return;
    visit(part);
    if (Array.isArray(part.parts)) for (const child of part.parts) step(child);
  };
  step(payload);
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z0-9]{2,8});/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x") || lower.startsWith("#")) {
      const code = Number.parseInt(
        lower.startsWith("#x") ? lower.slice(2) : lower.slice(1),
        lower.startsWith("#x") ? 16 : 10,
      );
      if (!(code > 0 && code <= 0x10ffff)) return match;
      // A lone surrogate is not a scalar value; leave the reference as written.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      if (code === 0xa0) return " ";
      // HTML maps &#128;-&#159; through windows-1252 (WHATWG numeric character
      // reference table); the unassigned slots stay as written.
      if (code >= 0x80 && code <= 0x9f) {
        const mapped = WINDOWS_1252_HIGH[code - 0x80];
        return mapped === code ? match : String.fromCodePoint(mapped);
      }
      return String.fromCodePoint(code);
    }
    return entities[lower] ?? match;
  });
}

/** Absolute http(s) URL without credentials, or null. */
export function safeGmailLinkHref(value: string): string | null {
  const candidate = decodeEntities(value.trim());
  if (!candidate || candidate.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(candidate);
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
  return url.href;
}

function linkText(html: string): string {
  // `[^<>]` keeps the tag strip linear on unbalanced markup.
  return decodeEntities(html.replace(/<[^<>]*>/g, " "))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nextMatch(
  html: string,
  pattern: RegExp,
  from: number,
): { index: number; end: number } | null {
  pattern.lastIndex = from;
  const found = pattern.exec(html);
  return found ? { index: found.index, end: pattern.lastIndex } : null;
}

/**
 * Calls `visit` for each `<a ...>inner</a>` outside comments, scripts and styles, in one forward
 * pass until it returns false. Every search resumes after the previous construct and the scan stops
 * at the first one left unclosed, so hostile mail (thousands of unclosed tags or comments) costs
 * linear time rather than quadratic regex backtracking on the server.
 */
function forEachAnchor(html: string, visit: (attributes: string, inner: string) => boolean): void {
  const open = /<(!--|script\b|style\b|a\b)/gi;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const kind = match[1].toLowerCase();
    if (kind !== "a") {
      const closing =
        kind === "!--" ? /-->/g : kind === "script" ? /<\/script\s*>/gi : /<\/style\s*>/gi;
      const end = nextMatch(html, closing, open.lastIndex);
      if (!end) return;
      open.lastIndex = end.end;
      continue;
    }
    const tagEnd = html.indexOf(">", open.lastIndex);
    if (tagEnd < 0) return;
    const end = nextMatch(html, /<\/a\s*>/gi, tagEnd + 1);
    if (!end) return;
    const attributes = html.slice(open.lastIndex, tagEnd);
    open.lastIndex = end.end;
    if (!visit(attributes, html.slice(tagEnd + 1, end.index))) return;
  }
}

/**
 * The value of the first `href` attribute. Attributes are read name by name, so text inside another
 * attribute's quoted value (for example `title="href=..."`) or a `data-href` is never taken.
 */
function hrefAttribute(attributes: string): string | null {
  const token = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/y;
  for (let match = token.exec(attributes); match; match = token.exec(attributes)) {
    if (match[1].toLowerCase() === "href") return match[2] ?? match[3] ?? match[4] ?? null;
    if (token.lastIndex >= attributes.length) break;
  }
  return null;
}

/**
 * Anchors (`<a href>`) from the message's text/html parts, in document order, deduplicated by
 * destination. Only absolute http(s) links without embedded credentials are returned; the anchor
 * text is reduced to plain text so clients can show both what the email says and where it goes.
 */
export function extractGmailHtmlLinks(
  payload: GmailPayloadPart | null | undefined,
  decode: (part: GmailPayloadPart) => string = decodeGmailPart,
): GmailMessageLink[] {
  if (!payload) return [];
  const links: GmailMessageLink[] = [];
  const seen = new Set<string>();
  walk(payload, (part) => {
    if (part.mimeType?.toLowerCase() !== "text/html" || typeof part.body?.data !== "string") return;
    forEachAnchor(decode(part), (attributes, inner) => {
      const href = safeGmailLinkHref(hrefAttribute(attributes) ?? "");
      if (href && !seen.has(href)) {
        seen.add(href);
        links.push({ href, text: linkText(inner) || new URL(href).hostname });
      }
      return true;
    });
  });
  return links;
}

/**
 * Search-row attachment hint. With format=metadata Gmail returns only the top-level MIME type, so
 * a multipart/mixed container (the attachment container) is the signal; with format=full any part
 * carrying a filename counts. It is a hint for a paperclip, not an attachment inventory.
 */
export function gmailHasAttachmentsHint(payload: GmailPayloadPart | null | undefined): boolean {
  if (!payload) return false;
  if (payload.mimeType?.toLowerCase() === "multipart/mixed") return true;
  let found = false;
  walk(payload, (part) => {
    if (typeof part.filename === "string" && part.filename.length > 0) found = true;
  });
  return found;
}

/** Gmail's list API omits Trash unless includeSpamTrash is set; explicit Spam, Trash or anywhere queries enable excluded locations. */
export function gmailSearchIncludesTrash(query: string | undefined): boolean {
  return (
    typeof query === "string" && /(?:^|[\s({])in:(?:spam|trash|anywhere)(?=[\s)}]|$)/i.test(query)
  );
}

/** Human HTML view is complete or explicitly unavailable; never a partial MIME body. */
export function extractGmailHtmlView(payload: GmailPayloadPart | null | undefined): {
  html: string | null;
  status: "available" | "none" | "too-large";
} {
  const pending: GmailPayloadPart[] = payload ? [payload] : [];
  let visited = 0;
  while (pending.length) {
    if (++visited > MAX_GMAIL_MIME_NODES) return { html: null, status: "too-large" };
    const part = pending.pop()!;
    if (part.filename || part.mimeType?.toLowerCase() === "message/rfc822") continue;
    if (part.mimeType?.toLowerCase() === "text/html" && typeof part.body?.data === "string") {
      if (part.body.data.length > 750000) return { html: null, status: "too-large" };
      const html = decodeGmailPart(part);
      return new TextEncoder().encode(html).length <= 512 * 1024
        ? { html, status: "available" }
        : { html: null, status: "too-large" };
    }
    for (const child of [...(part.parts ?? [])].reverse()) pending.push(child);
  }
  return { html: null, status: "none" };
}
