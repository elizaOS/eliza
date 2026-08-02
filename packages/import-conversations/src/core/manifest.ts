/**
 * Import-batch manifest: idempotency + uninstall bookkeeping.
 *
 * The manifest records, per imported conversation, the source-provided identity
 * `(source, sourceConversationId, updatedAt)` plus the DocumentSink ids that
 * conversation produced. This drives:
 *   - idempotent re-import: on re-upload, unchanged conversations are skipped,
 *     newer ones (later `updatedAt`) are re-imported as `updated`.
 *   - full-batch uninstall: enumerate every stored document id in a batch so
 *     the app side can `deleteDocument` each (scope §4.4, hard requirement).
 *
 * The manifest itself is a plain serializable object; the eliza-app side is
 * responsible for persisting it (e.g. as an import-state document). Core keeps
 * it in-memory + pure so the pipeline is unit-testable.
 */

import type { ConversationSource } from "./types.ts";

/** Classification of a conversation against the prior manifest state. */
export type ConversationChange = "added" | "unchanged" | "updated";

/** A single conversation's record within an import batch. */
export interface ManifestEntry {
  source: ConversationSource;
  sourceConversationId: string;
  /** Epoch ms `updatedAt` of the conversation at import time (0 when absent). */
  updatedAt: number;
  /** Document ids produced for this conversation (one per rendered part). */
  documentIds: string[];
  /** When this entry was last written, epoch ms. */
  importedAt: number;
}

/** A full import batch (one export upload). */
export interface ImportManifest {
  batchId: string;
  source: ConversationSource;
  /** Keyed by `sourceConversationId`. */
  entries: Record<string, ManifestEntry>;
  createdAt: number;
  updatedAt: number;
}

/** Build the dedup key for a conversation within a source namespace. */
export function manifestKey(
  source: ConversationSource,
  sourceConversationId: string,
): string {
  return `${source}:${sourceConversationId}`;
}

/** Create an empty manifest for a new import batch. */
export function createManifest(
  batchId: string,
  source: ConversationSource,
  now: number = Date.now(),
): ImportManifest {
  return {
    batchId,
    source,
    entries: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Classify a conversation against a (possibly prior) manifest.
 *
 * - No prior entry → `added`.
 * - Prior entry with an equal-or-newer stored `updatedAt` → `unchanged`.
 * - Prior entry with an older stored `updatedAt` (incoming is newer) →
 *   `updated`.
 *
 * A missing `updatedAt` on the incoming conversation is treated as `0`, so a
 * conversation that never advertises an update time re-imports as `unchanged`
 * once recorded (avoids churn) unless the export later supplies a real time.
 */
export function classifyConversation(
  manifest: ImportManifest,
  sourceConversationId: string,
  incomingUpdatedAt: number | undefined,
): ConversationChange {
  const prior = manifest.entries[sourceConversationId];
  if (!prior) {
    return "added";
  }
  const incoming = incomingUpdatedAt ?? 0;
  if (incoming > prior.updatedAt) {
    return "updated";
  }
  return "unchanged";
}

/**
 * Record (or replace) a conversation's entry after it has been stored. Returns
 * a new manifest object (does not mutate the input) so callers can keep the
 * prior state for reporting. Replacing an existing entry (the `updated` path)
 * overwrites its `documentIds` — callers should have already scheduled the old
 * documents for deletion via {@link entryDocumentIds}.
 */
export function recordConversation(
  manifest: ImportManifest,
  params: {
    source: ConversationSource;
    sourceConversationId: string;
    updatedAt: number | undefined;
    documentIds: string[];
  },
  now: number = Date.now(),
): ImportManifest {
  const entry: ManifestEntry = {
    source: params.source,
    sourceConversationId: params.sourceConversationId,
    updatedAt: params.updatedAt ?? 0,
    documentIds: [...params.documentIds],
    importedAt: now,
  };
  return {
    ...manifest,
    updatedAt: now,
    entries: {
      ...manifest.entries,
      [params.sourceConversationId]: entry,
    },
  };
}

/** Return the stored document ids for a conversation, or `[]` if not present. */
export function entryDocumentIds(
  manifest: ImportManifest,
  sourceConversationId: string,
): string[] {
  return manifest.entries[sourceConversationId]?.documentIds ?? [];
}

/**
 * Enumerate every document id in the batch — the uninstall surface. The
 * app-side uninstall walks this list and calls `deleteDocument` per id.
 */
export function enumerateBatchDocumentIds(manifest: ImportManifest): string[] {
  const ids: string[] = [];
  for (const entry of Object.values(manifest.entries)) {
    ids.push(...entry.documentIds);
  }
  return ids;
}

/** Total conversations recorded in the batch. */
export function manifestConversationCount(manifest: ImportManifest): number {
  return Object.keys(manifest.entries).length;
}
