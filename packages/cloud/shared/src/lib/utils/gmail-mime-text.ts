// Pure helpers for Gmail API message payloads (users.messages.get format=full). No network,
// no HTML rendering: links are returned as inert data for clients to review before opening.

import { MAX_GMAIL_MIME_NODES } from "@elizaos/plugin-google-workspace/gmail-mime-parts";

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

// Windows-1252 bytes 0x80-0x9f (ISO-8859-1 maps them to C1 controls). Undefined bytes stay as-is.
const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
const LATIN1_LABELS = new Set([
  "iso-8859-1",
  "iso8859-1",
  "iso_8859-1",
  "latin1",
  "latin-1",
  "l1",
  "us-ascii",
  "ascii",
  "windows-1252",
  "cp1252",
  "x-cp1252",
  "cp819",
  "ibm819",
]);
function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes)
    out += String.fromCharCode(
      byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_HIGH[byte - 0x80] : byte,
    );
  return out;
}

/** The `charset` parameter of a part's Content-Type header, lower-cased, or null. */
export function gmailPartCharset(part: GmailPayloadPart | null | undefined): string | null {
  const header = part?.headers?.find((row) => row?.name?.toLowerCase() === "content-type")?.value;
  if (typeof header !== "string") return null;
  const match = /;\s*charset\s*=\s*(?:"([^"]{1,64})"|([^\s;"]{1,64}))/i.exec(header);
  const label = (match?.[1] ?? match?.[2])?.trim().toLowerCase();
  return label || null;
}

/**
 * Decodes base64url part data with its declared charset. ISO-8859-1, US-ASCII and Windows-1252
 * decode as Windows-1252 (the WHATWG mapping, available even where TextDecoder lacks legacy
 * encodings); other labels use TextDecoder when the runtime supports them. Unknown labels and
 * undeclared charsets fall back to UTF-8.
 */
export function decodeGmailPartData(
  data: string,
  charset: string | null = null,
  strict = false,
): string {
  const bytes = Buffer.from(data, "base64url");
  if (
    strict &&
    (!/^[A-Za-z0-9_-]*={0,2}$/.test(data) ||
      bytes.toString("base64url") !== data.replace(/=+$/, ""))
  )
    throw new Error("Draft part encoding is invalid");
  const label = charset?.toLowerCase() ?? "utf-8";
  if (LATIN1_LABELS.has(label)) return decodeWindows1252(bytes);
  if (label !== "utf-8" && label !== "utf8") {
    try {
      return new TextDecoder(label, { fatal: strict }).decode(bytes);
    } catch {
      if (strict) throw new Error("Draft charset cannot be decoded losslessly");
      // Unsupported or invalid label: UTF-8 below.
    }
  }
  return new TextDecoder("utf-8", { fatal: strict }).decode(bytes);
}

/** Decodes one part's inline body with its own declared charset. */
export function decodeGmailPart(part: GmailPayloadPart, strict = false): string {
  return typeof part.body?.data === "string"
    ? decodeGmailPartData(part.body.data, gmailPartCharset(part), strict)
    : "";
}

/**
 * The first displayable body: the payload's own data, else text/plain then text/html among the
 * parts (recursing into multipart containers), each decoded with its declared charset.
 */
/**
 * The decoded body of the first part with exactly `mimeType` in the subtree,
 * searching every multipart container before the caller moves on to the next
 * mime type. A container's own nested result must not preempt the caller's
 * preference order: a text/html part inside an early container is not the
 * text/plain body a later sibling part carries.
 */
function findGmailBodyByMime(
  payload: GmailPayloadPart,
  mimeType: string,
  depth: number,
): string {
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

export function extractGmailBodyText(
  payload: GmailPayloadPart | null | undefined,
  depth = 0,
): string {
  if (!payload) return "";
  if (depth > 20) throw new Error("Gmail MIME nesting exceeds the supported depth");
  if (typeof payload.body?.data === "string") return decodeGmailPart(payload);
  if (!Array.isArray(payload.parts)) return "";
  for (const mimeType of ["text/plain", "text/html"]) {
    const found = findGmailBodyByMime(payload, mimeType, depth + 1);
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
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z0-9]{2,8});/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
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

/** Gmail's list API omits Trash unless includeSpamTrash is set; only an explicit in:trash query sets it. */
export function gmailSearchIncludesTrash(query: string | undefined): boolean {
  return typeof query === "string" && /(?:^|\s)in:trash(?=\s|$)/i.test(query);
}
