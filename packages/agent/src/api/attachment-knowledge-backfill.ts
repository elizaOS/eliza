/**
 * One-time idempotent backfill for pre-existing knowledge records that predate
 * the attachment→knowledge ingest tagging (#13593). Transcript-mirror documents
 * (tag `transcript`) and meeting mirrors were written before this slice added
 * the room/sender/media-format facets, so a search on `roomId`/`mediaFormat`
 * misses them. This sweep adds:
 *
 *   - `metadata.roomId` (from the record's own `roomId`, when absent), and
 *   - `metadata.mediaFormat = "transcript"` + the `media-format:transcript` tag
 *
 * WITHOUT touching the `transcriptId` / `audioUrl` links (those stay the source
 * of truth). It is idempotent: a record already carrying both facets is skipped,
 * so re-running is a no-op. Runs as a runtime task so it executes once wherever
 * the agent runs and never blocks boot.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

const DOCUMENTS_TABLE = "documents";
const TRANSCRIPT_TAG = "transcript";
const MEDIA_FORMAT_TAG_PREFIX = "media-format:";
const TRANSCRIPT_MEDIA_FORMAT = "transcript";
const BACKFILL_BATCH_SIZE = 500;

const BACKFILL_TASK_NAME = "KNOWLEDGE_TAG_BACKFILL";
const BACKFILL_TAGS = ["queue", "knowledge-tag-backfill"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringTags(metadata: Record<string, unknown> | undefined): string[] {
  const tags = metadata?.tags;
  return Array.isArray(tags)
    ? tags.filter((value): value is string => typeof value === "string")
    : [];
}

/** True when a record is a transcript mirror (tag or explicit transcriptId). */
function isTranscriptMirror(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  if (typeof metadata.transcriptId === "string") return true;
  return stringTags(metadata).includes(TRANSCRIPT_TAG);
}

/**
 * Compute the patched metadata for a transcript-mirror record, or null when it
 * already carries both the `roomId` and `mediaFormat`/format-tag facets (i.e.
 * nothing to do — the idempotency check).
 */
export function computeTranscriptBackfillMetadata(
  memory: Memory,
): Record<string, unknown> | null {
  const metadata = asRecord(memory.metadata);
  if (!isTranscriptMirror(metadata)) return null;

  const tags = stringTags(metadata);
  const hasFormatTag = tags.some((tag) =>
    tag.startsWith(MEDIA_FORMAT_TAG_PREFIX),
  );
  const hasFormat =
    typeof metadata?.mediaFormat === "string" &&
    metadata.mediaFormat.length > 0;
  const existingRoomId =
    typeof metadata?.roomId === "string" ? metadata.roomId : undefined;
  const recordRoomId =
    typeof memory.roomId === "string" ? (memory.roomId as UUID) : undefined;
  const needsRoomId = !existingRoomId && Boolean(recordRoomId);

  if (hasFormat && hasFormatTag && !needsRoomId) {
    return null; // already backfilled — idempotent no-op
  }

  const nextTags = hasFormatTag
    ? tags
    : [...tags, `${MEDIA_FORMAT_TAG_PREFIX}${TRANSCRIPT_MEDIA_FORMAT}`];

  return {
    ...(metadata ?? {}),
    tags: nextTags,
    mediaFormat: TRANSCRIPT_MEDIA_FORMAT,
    ...(needsRoomId ? { roomId: recordRoomId } : {}),
  };
}

/**
 * Scan the documents table and backfill transcript-mirror records missing the
 * room/media-format facets. Returns the number of records updated. Pure sweep:
 * link fields (`transcriptId`, `audioUrl`) are preserved.
 */
export async function backfillTranscriptKnowledgeTags(
  runtime: IAgentRuntime,
): Promise<number> {
  let offset = 0;
  let updated = 0;

  while (true) {
    const batch = await runtime.getMemories({
      tableName: DOCUMENTS_TABLE,
      // Scope the sweep to THIS agent: in a shared/multi-agent store
      // `getMemories` only filters by fields passed explicitly, so without
      // agentId the backfill could fetch (and `updateMemory` rewrite) another
      // agent's transcript documents.
      agentId: runtime.agentId,
      count: BACKFILL_BATCH_SIZE,
      offset,
    });
    if (batch.length === 0) break;

    for (const memory of batch) {
      if (!memory.id) continue;
      // Defense in depth: never patch a row owned by a different agent even if
      // the adapter ignored the agentId filter.
      if (memory.agentId && memory.agentId !== runtime.agentId) continue;
      const patched = computeTranscriptBackfillMetadata(memory);
      if (!patched) continue;
      await runtime.updateMemory({
        id: memory.id as UUID,
        metadata: patched as Memory["metadata"],
      });
      updated += 1;
    }

    if (batch.length < BACKFILL_BATCH_SIZE) break;
    offset += BACKFILL_BATCH_SIZE;
  }

  return updated;
}

/**
 * Register the one-time backfill task. The worker is idempotent, so a duplicate
 * run is harmless; we also guard task creation so we don't enqueue it twice.
 */
export function registerAttachmentKnowledgeBackfillTask(
  runtime: IAgentRuntime,
): void {
  runtime.registerTaskWorker({
    name: BACKFILL_TASK_NAME,
    execute: async (rt) => {
      try {
        const updated = await backfillTranscriptKnowledgeTags(rt);
        if (updated > 0) {
          rt.logger.info(
            `[knowledge-backfill] tagged ${updated} transcript-mirror document(s) with roomId/mediaFormat`,
          );
        }
      } catch (err) {
        // error-policy:J7 the one-time metadata sweep must not kill runtime
        // startup, but the failure needs to reach RECENT_ERRORS/escalation.
        rt.reportError("knowledge-backfill", err);
        rt.logger.warn(
          `[knowledge-backfill] sweep failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return undefined;
    },
  });

  void (async () => {
    try {
      const existing = await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: BACKFILL_TAGS,
      });
      if (existing.some((task) => task.name === BACKFILL_TASK_NAME)) return;
      await runtime.createTask({
        name: BACKFILL_TASK_NAME,
        description:
          "One-time backfill of room/media-format tags on transcript-mirror knowledge records",
        tags: [...BACKFILL_TAGS],
        agentId: runtime.agentId,
        metadata: { updatedAt: Date.now() },
      });
    } catch (err) {
      // error-policy:J7 scheduling is diagnostic/background work; report it
      // observably while allowing the agent to continue booting.
      runtime.reportError("knowledge-backfill-schedule", err);
      runtime.logger.warn(
        `[knowledge-backfill] failed to schedule backfill task: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
}
