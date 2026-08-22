/**
 * Content-addressed durable store for orchestrator text content, and the
 * bounded-projection primitive built on it. This is the recoverability half of
 * the durable-content contract: a bounded view is only allowed to drop bytes
 * when the COMPLETE value is persisted here first and the view carries a
 * reference that resolves through the orchestrator's own HTTP surface
 * (`GET /api/orchestrator/content/:sha256?offset=&limit=`) — a textual
 * truncation marker alone is not recoverability.
 *
 * Records are content-addressed (`<sha256>.txt` under the trajectory dir), so
 * repeated projections of the same content deduplicate, references are stable
 * across retries, and the store never needs coordination. Provider credentials
 * are masked at write time with core's canonical redactor, because these files
 * outlive their sessions.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContentReference, ReadView } from "@elizaos/core";
import {
  redactSensitiveText,
  resolveTrajectoryDir,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";

const CONTENT_DIR_NAME = "orchestrator-content";
const SHA256_RE = /^[0-9a-f]{64}$/u;

function contentDir(): string {
  return path.join(resolveTrajectoryDir(), CONTENT_DIR_NAME);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Persist the complete text and return its resolvable reference. Idempotent:
 * the record is content-addressed, so persisting the same text twice writes
 * once. Failures throw — a caller about to emit a bounded view MUST know the
 * durable record exists before dropping bytes from the view.
 */
export function persistDurableContent(text: string): ContentReference {
  const wellFormed = toWellFormedUnicode(text);
  const masked = redactSensitiveText(wellFormed);
  const digest = sha256(masked);
  const dir = contentDir();
  const file = path.join(dir, `${digest}.txt`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, masked, "utf8");
    fs.renameSync(tmp, file);
  }
  return { kind: "tool-result", ref: `acpx-content:${digest}` };
}

export interface DurableContentWindow {
  text: string;
  offset: number;
  limit: number;
  totalBytes: number;
  hasMore: boolean;
  sourceSha256: string;
}

/** Resolve a window of a stored record by its sha256 (the token after
 *  `acpx-content:`). Returns undefined for an unknown or malformed ref. */
export function readDurableContent(
  sha: string,
  opts: { offset?: number; limit?: number } = {},
): DurableContentWindow | undefined {
  if (!SHA256_RE.test(sha)) return undefined;
  const file = path.join(contentDir(), `${sha}.txt`);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (err) {
    // error-policy:J3 ENOENT is the explicit unknown-record result the route
    // turns into a 404; any other read failure is a real fault.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
  const totalBytes = buffer.byteLength;
  const offset = Math.max(0, Math.min(opts.offset ?? 0, totalBytes));
  const limit = Math.max(1, Math.min(opts.limit ?? 65_536, 1_048_576));
  const slice = buffer.subarray(offset, offset + limit);
  return {
    text: slice.toString("utf8"),
    offset,
    limit,
    totalBytes,
    hasMore: offset + slice.byteLength < totalBytes,
    sourceSha256: sha,
  };
}

export interface DurableProjection {
  /** The bounded text; a partial view ends with a marker naming the
   *  RESOLVABLE reference of the complete stored record. */
  view: string;
  truncated: boolean;
  /** Present iff truncated: the persisted complete record's reference plus
   *  the progressive-read envelope for the emitted head. */
  reference?: ContentReference;
  read?: ReadView;
}

/**
 * Bounded projection of arbitrary content. Short content passes through
 * whole. Oversized content is FIRST persisted to the durable store, then the
 * head is emitted with a continuation marker naming the stored record — so
 * the omitted bytes are recoverable through
 * `GET /api/orchestrator/content/<sha256>?offset=<n>`.
 */
export function durableProjection(
  full: string,
  budgetChars: number,
): DurableProjection {
  const wellFormed = toWellFormedUnicode(full);
  if (wellFormed.length <= budgetChars) {
    return { view: wellFormed, truncated: false };
  }
  const reference = persistDurableContent(wellFormed);
  const sha = reference.ref.slice("acpx-content:".length);
  const marker = `\n… [${wellFormed.length} chars total — full content: GET /api/orchestrator/content/${sha}]`;
  const headBudget = Math.max(0, budgetChars - marker.length);
  const head = truncateWellFormed(wellFormed, headBudget).trimEnd();
  const headBytes = Buffer.byteLength(head, "utf8");
  return {
    view: `${head}${marker}`,
    truncated: true,
    reference,
    read: {
      reference,
      slice: {
        range: {
          unit: "byte",
          start: 0,
          end: headBytes,
          total: Buffer.byteLength(wellFormed, "utf8"),
        },
        hasPrevious: false,
        hasMore: true,
        nextOffset: headBytes,
        completeness: "partial-recoverable",
        sliceSha256: sha256(head),
        sourceSha256: sha,
      },
    },
  };
}
