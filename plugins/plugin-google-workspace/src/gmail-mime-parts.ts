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
    if (visit(part) === true) return true;
    const partsDescriptor = Object.getOwnPropertyDescriptor(part, "parts");
    if (!partsDescriptor || !("value" in partsDescriptor)) return false;
    const children = partsDescriptor.value;
    if (!Array.isArray(children)) return false;
    reserve(ctx, children.length);
    for (let index = 0; index < children.length; index += 1) {
      if (!(index in children)) continue;
      const child = children[index];
      if (!child || typeof child !== "object") continue;
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
    const directBody = Object.getOwnPropertyDescriptor(part, "body");
    const mimeDescriptor = Object.getOwnPropertyDescriptor(part, "mimeType");
    const mime = mimeDescriptor && "value" in mimeDescriptor ? mimeDescriptor.value : part.mimeType;
    if (
      mime === mimeType &&
      directBody &&
      "value" in directBody &&
      directBody.value &&
      typeof (directBody.value as { data?: unknown }).data === "string"
    ) {
      return readBody(part);
    }

    const partsDescriptor = Object.getOwnPropertyDescriptor(part, "parts");
    if (!partsDescriptor || !("value" in partsDescriptor)) return "";
    const children = partsDescriptor.value;
    if (!Array.isArray(children)) return "";
    reserve(ctx, children.length);
    for (let index = 0; index < children.length; index += 1) {
      if (!(index in children)) continue;
      const child = children[index];
      if (!child || typeof child !== "object") continue;
      const nested = extractGmailMimeBodyInner(child, mimeType, readBody, depth + 1, ctx, true);
      if (nested) return nested;
    }
    return "";
  } finally {
    ctx.visiting.delete(part);
  }
}
