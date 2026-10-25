/**
 * Bounds the Gmail MIME `parts` tree before ingest walks it. Gmail API
 * payloads carry untrusted nested multipart from hostile mail; the previous
 * recursive collect/extract RangeError'd a 20k nest on Node 24.15.0.
 * Depth, node, cycle, and own-data-descriptor limits are all load-bearing.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_GMAIL_MIME_DEPTH = 32;
export const MAX_GMAIL_MIME_NODES = 2_048;
export const GMAIL_MIME_PART_UNBOUNDED = "GMAIL_MIME_PART_UNBOUNDED";

export type GmailMimePartLike = {
  mimeType?: string | null;
  partId?: string | null;
  filename?: string | null;
  headers?: GmailMimeHeader[] | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null;
  parts?: GmailMimePartLike[] | null;
};

export type GmailMimeHeader = { name?: string | null; value?: string | null };

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

type OwnData = { found: false } | { found: true; value: unknown };

function failUnbounded(context: Record<string, unknown>, cause?: unknown): never {
  throw new ElizaError("Gmail MIME part tree exceeds the ingest walk budget", {
    code: GMAIL_MIME_PART_UNBOUNDED,
    context,
    severity: "fatal",
    ...(cause !== undefined ? { cause } : {}),
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_GMAIL_MIME_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_GMAIL_MIME_NODES,
    });
  }
  ctx.visits += count;
}

function ownData(object: object, key: PropertyKey, field: string): OwnData {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (cause) {
    // error-policy:J2 hostile descriptor traps become typed MIME fail-closed.
    failUnbounded({ reflection: "getOwnPropertyDescriptor", field }, cause);
  }
  if (!descriptor) return { found: false };
  if (!Object.hasOwn(descriptor, "value")) {
    failUnbounded({ accessor: field });
  }
  return { found: true, value: descriptor.value };
}

function isMimeChildArray(value: unknown, field = "parts"): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch (cause) {
    // error-policy:J2 revoked or trapping arrays become typed MIME fail-closed.
    failUnbounded({ reflection: "Array.isArray", field }, cause);
  }
}

function snapshotHeaders(part: object): GmailMimeHeader[] | undefined {
  const headersOwn = ownData(part, "headers", "headers");
  if (!headersOwn.found || !isMimeChildArray(headersOwn.value, "headers")) return undefined;
  const rows = headersOwn.value;
  const lengthOwn = ownData(rows, "length", "headers.length");
  const length = lengthOwn.found ? lengthOwn.value : 0;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    failUnbounded({ field: "headers.length", length });
  }
  const headers: GmailMimeHeader[] = [];
  for (let index = 0; index < length; index += 1) {
    const slot = ownData(rows, index, "headers[]");
    if (!slot.found || !slot.value || typeof slot.value !== "object") continue;
    const name = ownData(slot.value, "name", "headers[].name");
    const value = ownData(slot.value, "value", "headers[].value");
    headers.push({
      name: name.found && typeof name.value === "string" ? name.value : undefined,
      value: value.found && typeof value.value === "string" ? value.value : undefined,
    });
  }
  return headers;
}

export function snapshotGmailMimePart(part: object): GmailMimePartLike {
  const mime = ownData(part, "mimeType", "mimeType");
  const bodyOwn = ownData(part, "body", "body");
  const snapshot: GmailMimePartLike = {};
  for (const field of ["partId", "filename"] as const) {
    const item = ownData(part, field, field);
    if (item.found) snapshot[field] = item.value as string | null | undefined;
  }
  if (mime.found) {
    snapshot.mimeType = mime.value as string | null | undefined;
  }
  const headers = snapshotHeaders(part);
  if (headers) snapshot.headers = headers;
  if (!bodyOwn.found) return snapshot;
  if (bodyOwn.value == null) {
    snapshot.body = bodyOwn.value as null | undefined;
    return snapshot;
  }
  if (typeof bodyOwn.value !== "object") {
    snapshot.body = undefined;
    return snapshot;
  }
  const data = ownData(bodyOwn.value, "data", "body.data");
  snapshot.body = {
    data:
      !data.found || data.value == null || typeof data.value === "string"
        ? ((data.found ? data.value : undefined) as string | null | undefined)
        : undefined,
  };
  const attachmentId = ownData(bodyOwn.value, "attachmentId", "body.attachmentId");
  const size = ownData(bodyOwn.value, "size", "body.size");
  if (attachmentId.found)
    snapshot.body.attachmentId = attachmentId.value as string | null | undefined;
  if (size.found) snapshot.body.size = size.value as number | null | undefined;
  return snapshot;
}

function forEachMimeChild(
  part: object,
  ctx: WalkContext,
  visitChild: (child: object) => boolean
): boolean {
  const partsOwn = ownData(part, "parts", "parts");
  if (!partsOwn.found) return false;
  if (!isMimeChildArray(partsOwn.value)) return false;
  const children = partsOwn.value;
  const lengthOwn = ownData(children, "length", "parts.length");
  const length = lengthOwn.found ? lengthOwn.value : 0;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    failUnbounded({ field: "parts.length", length });
  }
  reserve(ctx, length);
  for (let index = 0; index < length; index += 1) {
    const slot = ownData(children, index, "parts[]");
    if (!slot.found || !slot.value || typeof slot.value !== "object") continue;
    if (visitChild(slot.value)) return true;
  }
  return false;
}

/**
 * Depth-first visit of a Gmail MIME part tree. `visit` returning true aborts
 * the remaining walk (used when extract has already found a body). Visitors
 * receive an own-data snapshot so they never read accessors on the raw part.
 */
export function walkGmailMimeParts(
  part: GmailMimePartLike | undefined,
  visit: (part: GmailMimePartLike) => boolean | undefined
): void {
  if (!part) return;
  walkGmailMimePartsInner(part, 0, { visits: 0, visiting: new WeakSet<object>() }, visit);
}

function walkGmailMimePartsInner(
  part: object,
  depth: number,
  ctx: WalkContext,
  visit: (part: GmailMimePartLike) => boolean | undefined,
  visitAlreadyReserved = false
): boolean {
  if (depth > MAX_GMAIL_MIME_DEPTH) {
    failUnbounded({ depth, max: MAX_GMAIL_MIME_DEPTH });
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (ctx.visiting.has(part)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(part);
  try {
    const snapshot = snapshotGmailMimePart(part);
    if (visit(snapshot) === true) return true;
    return forEachMimeChild(part, ctx, (child) =>
      walkGmailMimePartsInner(child, depth + 1, ctx, visit, true)
    );
  } finally {
    ctx.visiting.delete(part);
  }
}

/**
 * First MIME body whose type matches, in the historical DFS order: a matching
 * node is returned without walking its children; an empty decoded body does
 * not hide later siblings.
 */
export function extractGmailMimeBody(
  part: GmailMimePartLike | undefined,
  mimeType: string,
  readBody: (part: GmailMimePartLike) => string
): string {
  if (!part) return "";
  return extractGmailMimeBodyInner(part, mimeType, readBody, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}

function extractGmailMimeBodyInner(
  part: object,
  mimeType: string,
  readBody: (part: GmailMimePartLike) => string,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false
): string {
  if (depth > MAX_GMAIL_MIME_DEPTH) {
    failUnbounded({ depth, max: MAX_GMAIL_MIME_DEPTH });
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (ctx.visiting.has(part)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(part);
  try {
    const snapshot = snapshotGmailMimePart(part);
    if (snapshot.mimeType === mimeType && typeof snapshot.body?.data === "string") {
      return readBody(snapshot);
    }
    let found = "";
    forEachMimeChild(part, ctx, (child) => {
      const nested = extractGmailMimeBodyInner(child, mimeType, readBody, depth + 1, ctx, true);
      if (nested) {
        found = nested;
        return true;
      }
      return false;
    });
    return found;
  } finally {
    ctx.visiting.delete(part);
  }
}

// Windows-1252 bytes 0x80-0x9f (ISO-8859-1 maps them to C1 controls). Undefined bytes stay as-is.
export const WINDOWS_1252_HIGH = [
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
      byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_HIGH[byte - 0x80] : byte
    );
  return out;
}

/** The `charset` parameter of a part's Content-Type header, lower-cased, or null. */
export function gmailPartCharset(
  part: { headers?: readonly (GmailMimeHeader | null | undefined)[] | null } | null | undefined
): string | null {
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
  strict = false
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
