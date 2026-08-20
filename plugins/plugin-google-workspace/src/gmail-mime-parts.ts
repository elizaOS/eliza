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
  body?: { data?: string | null } | null;
  parts?: GmailMimePartLike[] | null;
};

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

type OwnData = { found: false } | { found: true; value: unknown };

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

function ownData(object: object, key: PropertyKey, field: string): OwnData {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return { found: false };
  if (!Object.hasOwn(descriptor, "value")) {
    failUnbounded({ accessor: field });
  }
  return { found: true, value: descriptor.value };
}

function snapshotMimePart(part: object): GmailMimePartLike {
  const mime = ownData(part, "mimeType", "mimeType");
  const bodyOwn = ownData(part, "body", "body");
  const snapshot: GmailMimePartLike = {};
  if (mime.found) {
    snapshot.mimeType = mime.value as string | null | undefined;
  }
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
  return snapshot;
}

function childParts(part: object, ctx: WalkContext): object[] {
  const partsOwn = ownData(part, "parts", "parts");
  if (!partsOwn.found) return [];
  const children = partsOwn.value;
  if (!Array.isArray(children)) return [];
  const lengthOwn = ownData(children, "length", "parts.length");
  const length = lengthOwn.found ? lengthOwn.value : 0;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    failUnbounded({ field: "parts.length", length });
  }
  reserve(ctx, length);
  const out: object[] = [];
  for (let index = 0; index < length; index += 1) {
    const slot = ownData(children, index, "parts[]");
    if (!slot.found || !slot.value || typeof slot.value !== "object") continue;
    out.push(slot.value);
  }
  return out;
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
    const snapshot = snapshotMimePart(part);
    if (visit(snapshot) === true) return true;
    for (const child of childParts(part, ctx)) {
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
    const snapshot = snapshotMimePart(part);
    if (snapshot.mimeType === mimeType && typeof snapshot.body?.data === "string") {
      return readBody(snapshot);
    }
    for (const child of childParts(part, ctx)) {
      const nested = extractGmailMimeBodyInner(child, mimeType, readBody, depth + 1, ctx, true);
      if (nested) return nested;
    }
    return "";
  } finally {
    ctx.visiting.delete(part);
  }
}
