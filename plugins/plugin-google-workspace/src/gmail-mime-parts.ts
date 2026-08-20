/**
 * Bounds the Gmail MIME `parts` tree before ingest walks it. Gmail API
 * payloads carry untrusted nested multipart from hostile mail; the previous
 * recursive collect/extract RangeError'd a 20k nest on Node 24.15.0.
 * Depth, node, and cycle limits are all load-bearing.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_GMAIL_MIME_DEPTH = 32;
export const MAX_GMAIL_MIME_NODES = 2_048;
export const GMAIL_MIME_PART_UNBOUNDED = "GMAIL_MIME_PART_UNBOUNDED";

export type GmailMimePartLike = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailMimePartLike[] | null;
};

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failUnbounded(context: Record<string, unknown>): never {
  throw new ElizaError("Gmail MIME part tree exceeds the ingest walk budget", {
    code: GMAIL_MIME_PART_UNBOUNDED,
    context,
    severity: "fatal",
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

function ownDataValue(value: object, key: string, location: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    failUnbounded({ accessor: true, location });
  }
  return descriptor.value;
}

function snapshotPart(part: GmailMimePartLike): GmailMimePartLike {
  const mimeType = ownDataValue(part, "mimeType", "part.mimeType");
  const body = ownDataValue(part, "body", "part.body");
  let safeBody: GmailMimePartLike["body"];
  if (body && typeof body === "object") {
    const data = ownDataValue(body, "data", "part.body.data");
    safeBody = { data: typeof data === "string" || data === null ? data : undefined };
  } else {
    safeBody = body === null ? null : undefined;
  }
  return {
    mimeType: typeof mimeType === "string" || mimeType === null ? mimeType : undefined,
    body: safeBody,
  };
}

function arrayLength(parts: GmailMimePartLike[]): number {
  const length = ownDataValue(parts, "length", "part.parts.length");
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    failUnbounded({ arrayLength: true });
  }
  return length as number;
}

function arrayChild(parts: GmailMimePartLike[], index: number): GmailMimePartLike | undefined {
  const child = ownDataValue(parts, String(index), `part.parts[${index}]`);
  return child && typeof child === "object" ? child : undefined;
}

/**
 * Depth-first visit of a Gmail MIME part tree. `visit` returning true aborts
 * the remaining walk (used when extract has already found a body).
 */
export function walkGmailMimeParts(
  part: GmailMimePartLike | undefined,
  visit: (part: GmailMimePartLike) => boolean | undefined
): void {
  if (!part) return;
  walkGmailMimePartsInner(part, 0, { visits: 0, visiting: new WeakSet<object>() }, visit);
}

function walkGmailMimePartsInner(
  part: GmailMimePartLike,
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
    if (visit(snapshotPart(part)) === true) return true;
    const children = ownDataValue(part, "parts", "part.parts");
    if (!Array.isArray(children)) return false;
    const length = arrayLength(children);
    reserve(ctx, length);
    for (let index = 0; index < length; index += 1) {
      const child = arrayChild(children, index);
      if (!child) continue;
      if (walkGmailMimePartsInner(child, depth + 1, ctx, visit, true)) {
        return true;
      }
    }
    return false;
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
  part: GmailMimePartLike,
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
    const safePart = snapshotPart(part);
    if (safePart.mimeType === mimeType && typeof safePart.body?.data === "string") {
      return readBody(safePart);
    }

    const children = ownDataValue(part, "parts", "part.parts");
    if (!Array.isArray(children)) return "";
    const length = arrayLength(children);
    reserve(ctx, length);
    for (let index = 0; index < length; index += 1) {
      const child = arrayChild(children, index);
      if (!child) continue;
      const nested = extractGmailMimeBodyInner(child, mimeType, readBody, depth + 1, ctx, true);
      if (nested) return nested;
    }
    return "";
  } finally {
    ctx.visiting.delete(part);
  }
}
