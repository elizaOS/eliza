/**
 * Durable complete content with bounded model views (#24262 close-out).
 *
 * The contract, from the review that closed the original orchestration PR:
 * canonical content is persisted IN FULL; every capped string handed to a
 * model prompt or a chat surface is a VIEW derived from that durable content,
 * and a partial view carries a continuation reference so the reader — model
 * or human — can recover the remainder instead of losing it.
 *
 * Two conventions compose here:
 * - `canonical<Thing>` / `provider<Thing>` metadata keys (introduced by the
 *   auto-submit PR title repair): the canonical value is stored untruncated;
 *   a provider-bounded payload is derived explicitly, named, and stored next
 *   to it so the derivation is auditable.
 * - {@link ContentReference} / {@link ReadView} from @elizaos/core (#24305):
 *   the source-neutral progressive-read envelope. Views produced here use
 *   the `tool-result` kind with orchestrator-owned opaque refs; the owning
 *   HTTP surfaces resolve continuations:
 *     `acpx-session-output:<sessionId>`  → GET /api/coding-agents/:id/output
 *     `acpx-task:<taskId>`               → GET /api/orchestrator/tasks/:id
 *     `acpx-task-meta:<taskId>:<key>`    → task metadata key on the same route
 */
import { createHash } from "node:crypto";
import type {
  ContentReference,
  ReadCompleteness,
  ReadView,
} from "@elizaos/core";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

export interface BoundedContentView {
  /** The bounded text. Partial views end with a one-line continuation
   *  marker naming the reference. */
  view: string;
  /** True when `view` carries less than the full content. */
  truncated: boolean;
  /** The progressive-read envelope for a partial view; absent when the
   *  content fit whole. */
  read?: ReadView;
}

/** An orchestrator-owned content reference (opaque, model-safe). */
export function orchestratorContentRef(
  scope: "session-output" | "task" | "task-meta",
  id: string,
  key?: string,
): ContentReference {
  const ref = [`acpx-${scope}`, id, ...(key ? [key] : [])]
    .join(":")
    // The core contract requires OPAQUE_REFERENCE_PATTERN-safe tokens.
    .replace(/[^A-Za-z0-9._:~-]/gu, "~");
  return { kind: "tool-result", ref: ref.slice(0, 256) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Derive a bounded view of durable content. NEVER call this on content that
 * is not persisted in full somewhere the reference can reach — the marker
 * promises the remainder is recoverable, and a false promise is worse than a
 * silent cut.
 */
export function boundedContentView(
  full: string,
  budgetChars: number,
  reference: ContentReference,
  opts: { completeness?: ReadCompleteness } = {},
): BoundedContentView {
  const wellFormed = toWellFormedUnicode(full);
  if (wellFormed.length <= budgetChars) {
    return { view: wellFormed, truncated: false };
  }
  const marker = `\n… [view of ${budgetChars} of ${wellFormed.length} chars — full content: ${reference.ref}]`;
  const headBudget = Math.max(0, budgetChars - marker.length);
  const head = truncateWellFormed(wellFormed, headBudget).trimEnd();
  return {
    view: `${head}${marker}`,
    truncated: true,
    read: {
      reference,
      slice: {
        range: {
          unit: "byte",
          start: 0,
          end: Buffer.byteLength(head, "utf8"),
          total: Buffer.byteLength(wellFormed, "utf8"),
        },
        hasPrevious: false,
        hasMore: true,
        nextOffset: Buffer.byteLength(head, "utf8"),
        completeness: opts.completeness ?? "partial-recoverable",
        sliceSha256: sha256(head),
        sourceSha256: sha256(wellFormed),
      },
    },
  };
}

/**
 * Canonical/provider pair for a value a downstream surface hard-bounds
 * (GitHub title, Discord message, room name, served slug). The canonical
 * value is what gets persisted; the provider value is what gets sent.
 */
export interface CanonicalProviderPair {
  canonical: string;
  provider: string;
  truncated: boolean;
}

export function canonicalProviderPair(
  canonical: string,
  providerLimit: number,
): CanonicalProviderPair {
  const wellFormed = toWellFormedUnicode(canonical);
  const provider = truncateWellFormed(wellFormed, providerLimit);
  return {
    canonical: wellFormed,
    provider,
    truncated: provider.length < wellFormed.length,
  };
}
