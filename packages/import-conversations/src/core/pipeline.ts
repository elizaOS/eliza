/**
 * The ingestion pipeline: parse → redact → render → dedup(manifest) → store →
 * report. Streaming by construction — it consumes the parser's
 * `AsyncIterable<NormalizedConversation>` and never buffers all conversations.
 *
 * Storage goes through the injected {@link DocumentSink} port so core stays
 * decoupled from eliza's real DocumentService (the app side supplies a thin
 * adapter). Scope/provenance metadata is applied per scope §4.2/§4.4:
 * `user-private` scope, `import` provenance, an import metadata block, and
 * provenance tags.
 *
 * Progress events (`{ processed, total }`) are yielded for background-job UIs.
 */

import {
  classifyConversation,
  createManifest,
  entryDocumentIds,
  type ImportManifest,
  recordConversation,
} from "./manifest.ts";
import { redactText } from "./redact.ts";
import { type RenderOptions, renderConversation } from "./render.ts";
import {
  type ImportReport,
  ReportBuilder,
  SKIP_REASON_DUPLICATE_CONTENT,
  SKIP_REASON_NO_MESSAGES,
} from "./report.ts";
import type { DocumentScope, DocumentSink, SinkDocument } from "./sink.ts";
import type {
  ConversationSource,
  NormalizedConversation,
  NormalizedMessage,
} from "./types.ts";

/** Progress event yielded as each conversation is processed. */
export interface ProgressEvent {
  processed: number;
  /** Total, when known ahead of time; otherwise undefined for pure streams. */
  total?: number;
  /** The conversation id just handled. */
  sourceConversationId: string;
}

export interface RunImportOptions {
  source: ConversationSource;
  batchId: string;
  /**
   * Storage port. Required for apply runs; may be omitted for a `dryRun`
   * (a no-op sink is used and never invoked in that path).
   */
  sink?: DocumentSink;
  /** The importing user's entity id — sets `scopedToEntityId`. */
  entityId?: string;
  /** Visibility scope for stored docs. Defaults to `user-private`. */
  scope?: DocumentScope;
  /** Prior manifest for idempotent re-import. A fresh one is created if absent. */
  manifest?: ImportManifest;
  /** Total conversation count, when known, for progress `total`. */
  total?: number;
  /** Dry run: classify + report but do not store. */
  dryRun?: boolean;
  /** Render/split options. */
  render?: RenderOptions;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/** The terminal result of an import run. */
export interface RunImportResult {
  report: ImportReport;
  manifest: ImportManifest;
}

/** True when a conversation has at least one message with renderable content. */
function hasRenderableMessages(conversation: NormalizedConversation): boolean {
  const messages = conversation.messages ?? [];
  return messages.some(
    (m) =>
      (m.text && m.text.trim().length > 0) || (m.attachments?.length ?? 0) > 0,
  );
}

/** Apply secret redaction to every message's text + inlined attachment text. */
function redactConversation(
  conversation: NormalizedConversation,
): NormalizedConversation {
  const messages: NormalizedMessage[] = conversation.messages.map((m) => {
    const redactedText = redactText(m.text ?? "");
    const attachments = m.attachments?.map((att) =>
      att.text ? { ...att, text: redactText(att.text) } : att,
    );
    return attachments
      ? { ...m, text: redactedText, attachments }
      : { ...m, text: redactedText };
  });
  // Also scrub the title (people paste keys into titles sometimes).
  const title = conversation.title
    ? redactText(conversation.title)
    : conversation.title;
  return { ...conversation, title, messages };
}

/** Build the provenance tag list for a conversation (scope §4.4). */
function buildTags(
  source: ConversationSource,
  sourceConversationId: string,
  dateMs: number | undefined,
): string[] {
  const tags = ["import", `import:${source}`, `conv:${sourceConversationId}`];
  if (dateMs !== undefined && Number.isFinite(dateMs)) {
    tags.push(`date:${new Date(dateMs).toISOString().slice(0, 7)}`);
  }
  return tags;
}

/** Filename for a rendered part (single-part omits the part suffix). */
function partFilename(
  source: ConversationSource,
  sourceConversationId: string,
  partIndex: number,
  partCount: number,
): string {
  const base = `${source}/${sourceConversationId}`;
  return partCount > 1 ? `${base}__part${partIndex + 1}.md` : `${base}.md`;
}

/**
 * Run the import pipeline over a streamed source. Yields {@link ProgressEvent}s
 * as it processes each conversation, and returns (via the async generator's
 * return value) the final {@link RunImportResult}.
 *
 * Consume it as an async generator to observe progress, then read the return:
 *
 * ```ts
 * const gen = runImport(source, opts);
 * let res = await gen.next();
 * while (!res.done) { onProgress(res.value); res = await gen.next(); }
 * const { report, manifest } = res.value; // final result
 * ```
 *
 * Or use {@link collectImport} to run to completion without progress handling.
 */
export async function* runImport(
  conversations: AsyncIterable<NormalizedConversation>,
  options: RunImportOptions,
): AsyncGenerator<ProgressEvent, RunImportResult, void> {
  const now = options.now ?? Date.now;
  const scope: DocumentScope = options.scope ?? "user-private";
  const dryRun = options.dryRun ?? false;
  if (!dryRun && !options.sink) {
    throw new Error(
      "runImport: a DocumentSink is required for a non-dry-run import",
    );
  }
  const report = new ReportBuilder(options.source, options.batchId, dryRun);
  let manifest =
    options.manifest ?? createManifest(options.batchId, options.source, now());

  let processed = 0;

  for await (const raw of conversations) {
    processed += 1;

    if (!hasRenderableMessages(raw)) {
      report.skip({
        sourceConversationId: raw.sourceConversationId,
        title: raw.title,
        reason: SKIP_REASON_NO_MESSAGES,
      });
      yield {
        processed,
        total: options.total,
        sourceConversationId: raw.sourceConversationId,
      };
      continue;
    }

    // Idempotency classification BEFORE any storage work.
    const change = classifyConversation(
      manifest,
      raw.sourceConversationId,
      raw.updatedAt,
    );

    if (change === "unchanged") {
      report.record({
        sourceConversationId: raw.sourceConversationId,
        title: raw.title,
        change: "unchanged",
        documentCount: entryDocumentIds(manifest, raw.sourceConversationId)
          .length,
      });
      yield {
        processed,
        total: options.total,
        sourceConversationId: raw.sourceConversationId,
      };
      continue;
    }

    // Redact, then render into (possibly multiple) part documents.
    const conversation = redactConversation(raw);
    const parts = renderConversation(
      conversation,
      options.source,
      options.render,
    );
    const tags = buildTags(
      options.source,
      conversation.sourceConversationId,
      conversation.updatedAt ?? conversation.createdAt,
    );

    if (dryRun) {
      report.record({
        sourceConversationId: conversation.sourceConversationId,
        title: conversation.title,
        change,
        documentCount: parts.length,
      });
      yield {
        processed,
        total: options.total,
        sourceConversationId: conversation.sourceConversationId,
      };
      continue;
    }

    // Non-null after the dry-run guard above.
    const sink = options.sink as DocumentSink;

    // On `updated`: delete the prior batch's documents for this conversation
    // before re-storing (uninstall-then-reimport keeps the batch clean).
    if (change === "updated") {
      for (const oldId of entryDocumentIds(
        manifest,
        conversation.sourceConversationId,
      )) {
        await sink.deleteDocument(oldId);
      }
    }

    const storedIds: string[] = [];
    let anyStored = false;
    for (const part of parts) {
      const doc: SinkDocument = {
        content: part.text,
        contentType: "text/markdown",
        originalFilename: partFilename(
          options.source,
          conversation.sourceConversationId,
          part.index,
          part.partCount,
        ),
        scope,
        scopedToEntityId: options.entityId,
        addedFrom: "import",
        metadata: {
          import: {
            source: options.source,
            sourceConversationId: conversation.sourceConversationId,
            importBatchId: options.batchId,
            exportedAt: conversation.updatedAt ?? conversation.createdAt,
            importedAt: now(),
            messageCount: part.messageCount,
            part:
              part.partCount > 1
                ? { index: part.index, count: part.partCount }
                : undefined,
            dateRange: {
              start: conversation.createdAt,
              end: conversation.updatedAt,
            },
          },
          tags,
        },
      };
      const result = await sink.addDocument(doc);
      storedIds.push(result.id);
      if (result.status === "stored") {
        anyStored = true;
      }
    }

    // If the sink deduped every part (nothing new stored) on an `added`
    // classification, report it as a content-dedup skip rather than added.
    if (change === "added" && !anyStored) {
      report.skip({
        sourceConversationId: conversation.sourceConversationId,
        title: conversation.title,
        reason: SKIP_REASON_DUPLICATE_CONTENT,
      });
    } else {
      report.record({
        sourceConversationId: conversation.sourceConversationId,
        title: conversation.title,
        change,
        documentCount: storedIds.length,
      });
      manifest = recordConversation(
        manifest,
        {
          source: options.source,
          sourceConversationId: conversation.sourceConversationId,
          updatedAt: conversation.updatedAt,
          documentIds: storedIds,
        },
        now(),
      );
    }

    yield {
      processed,
      total: options.total,
      sourceConversationId: conversation.sourceConversationId,
    };
  }

  return { report: report.build(), manifest };
}

/**
 * Convenience wrapper: run {@link runImport} to completion, ignoring progress
 * events, and return the final result.
 */
export async function collectImport(
  conversations: AsyncIterable<NormalizedConversation>,
  options: RunImportOptions,
): Promise<RunImportResult> {
  const gen = runImport(conversations, options);
  let res = await gen.next();
  while (!res.done) {
    res = await gen.next();
  }
  return res.value;
}

/**
 * Uninstall an entire import batch: delete every stored document enumerated by
 * the manifest. Returns the count deleted. (Convenience over
 * `enumerateBatchDocumentIds` + sink.deleteDocument.)
 */
export async function uninstallBatch(
  sink: Pick<DocumentSink, "deleteDocument">,
  manifest: ImportManifest,
): Promise<number> {
  let count = 0;
  for (const entry of Object.values(manifest.entries)) {
    for (const id of entry.documentIds) {
      await sink.deleteDocument(id);
      count += 1;
    }
  }
  return count;
}
