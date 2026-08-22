/**
 * Content-addressed durable store for orchestrator text content, and the
 * bounded-projection primitive built on it. This is the recoverability half of
 * the durable-content contract: a bounded view is only allowed to drop bytes
 * when the COMPLETE value is persisted here first and the view carries a
 * reference that resolves through the orchestrator's own HTTP surface
 * (`GET /api/orchestrator/content/:sha256?offset=&limit=`) — a textual
 * truncation marker alone is not recoverability.
 *
 * Canonicalize-once invariant: every input is normalized exactly once to its
 * canonical form — lone surrogates replaced, provider credentials masked with
 * core's redactor — and EVERYTHING derives from that one canonical text: the
 * content sha, the stored bytes, the projection head and marker, and the
 * ReadView hashes/offsets/totals. A projection view therefore can never leak
 * what storage redacted, and continuation metadata always describes the bytes
 * the retrieval route actually serves.
 *
 * Records are content-addressed (`<sha256>.txt` under the trajectory dir), so
 * repeated projections of the same content deduplicate, references are stable
 * across retries, and the store never needs coordination. Windowed reads snap
 * to UTF-8 code-point boundaries and report the actual byte range served, so
 * every window decodes cleanly on its own and windows reassemble losslessly.
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

/** The single canonicalization point: well-formed Unicode, then credential
 *  redaction. Every stored byte and every derived value comes from this. */
function canonicalizeDurableText(text: string): string {
  return redactSensitiveText(toWellFormedUnicode(text));
}

/** UTF-8 continuation bytes are 0b10xxxxxx; every other byte value starts a
 *  code point (stored records are always valid UTF-8 — they are encoded from
 *  well-formed canonical text). */
function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function persistCanonicalText(canonical: string): ContentReference {
  const digest = sha256(canonical);
  const dir = contentDir();
  const file = path.join(dir, `${digest}.txt`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, canonical, "utf8");
    fs.renameSync(tmp, file);
  }
  return { kind: "tool-result", ref: `acpx-content:${digest}` };
}

/**
 * Persist the complete text and return its resolvable reference. Idempotent:
 * the record is content-addressed, so persisting the same text twice writes
 * once. Failures throw — a caller about to emit a bounded view MUST know the
 * durable record exists before dropping bytes from the view.
 */
export function persistDurableContent(text: string): ContentReference {
  return persistCanonicalText(canonicalizeDurableText(text));
}

export interface DurableContentWindow {
  /** UTF-8 decode of exactly the `[offset, endOffset)` byte range. */
  text: string;
  /** ACTUAL start byte served: the requested offset snapped forward to the
   *  next code-point boundary so the window never starts mid-code-point. */
  offset: number;
  /** Exclusive end byte actually served; always a code-point boundary, so
   *  `text` decodes cleanly on its own. Continue reading from here. */
  endOffset: number;
  /** The requested byte budget (clamped to [1, 1 MiB]). The served range is
   *  at most this many bytes unless the budget cannot hold even the next
   *  code point, in which case exactly that one code point is served. */
  limit: number;
  totalBytes: number;
  hasMore: boolean;
  sourceSha256: string;
}

/** Resolve a window of a stored record by its sha256 (the token after
 *  `acpx-content:`). Returns undefined for an unknown or malformed ref.
 *  Window edges are snapped to UTF-8 code-point boundaries — start forward,
 *  end backward — so no window ever splits a code point; the actual byte
 *  range served is reported in `offset`/`endOffset`. */
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
  const limit = Math.max(1, Math.min(opts.limit ?? 65_536, 1_048_576));
  const requested = Math.max(0, Math.min(opts.offset ?? 0, totalBytes));
  let start = requested;
  while (
    start < totalBytes &&
    isUtf8ContinuationByte(buffer[start] as number)
  ) {
    start++;
  }
  let end = Math.min(start + limit, totalBytes);
  while (
    end > start &&
    end < totalBytes &&
    isUtf8ContinuationByte(buffer[end] as number)
  ) {
    end--;
  }
  // A budget smaller than the next code point would snap to an empty window
  // with hasMore=true — a pagination stall. Serve that one complete code
  // point instead; offset/endOffset report the actual range, so the caller's
  // continuation accounting stays exact.
  if (end === start && start < totalBytes) {
    end = start + 1;
    while (end < totalBytes && isUtf8ContinuationByte(buffer[end] as number)) {
      end++;
    }
  }
  const slice = buffer.subarray(start, end);
  return {
    text: slice.toString("utf8"),
    offset: start,
    endOffset: end,
    limit,
    totalBytes,
    hasMore: end < totalBytes,
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
 * Bounded projection of arbitrary content. The input is canonicalized ONCE
 * (well-formed + redacted) and both branches emit that canonical text — a
 * view never contains anything the durable record redacted. Short content
 * passes through whole. Oversized content is FIRST persisted to the durable
 * store, then the canonical head is emitted with a continuation marker naming
 * the stored record — so the omitted bytes are recoverable through
 * `GET /api/orchestrator/content/<sha256>?offset=<n>`, and head + windows
 * reassemble to exactly the canonical text.
 */
export function durableProjection(
  full: string,
  budgetChars: number,
): DurableProjection {
  const canonical = canonicalizeDurableText(full);
  if (canonical.length <= budgetChars) {
    return { view: canonical, truncated: false };
  }
  const reference = persistCanonicalText(canonical);
  const sha = reference.ref.slice("acpx-content:".length);
  const marker = `\n… [${canonical.length} chars total — full content: GET /api/orchestrator/content/${sha}]`;
  const headBudget = Math.max(0, budgetChars - marker.length);
  const head = truncateWellFormed(canonical, headBudget).trimEnd();
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
          total: Buffer.byteLength(canonical, "utf8"),
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
