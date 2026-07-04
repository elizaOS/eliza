/**
 * Meeting transcript persistence — lands attended-meeting transcripts in the
 * SAME store the Transcripts view reads (`/api/transcripts*`, served by
 * plugin-local-inference's transcripts-routes over the runtime `"transcripts"`
 * memories partition).
 *
 * Persistence path chosen: a local writer that replicates the exact record
 * shape (option c). Rationale:
 *  - (a) is impossible: plugin-local-inference constructs its TranscriptService
 *    per-request inside its route handlers; it never registers a runtime
 *    service exposing it.
 *  - (b) would mean a hard cross-plugin dependency on the opt-in, native-heavy
 *    local-inference plugin (meetings must transcribe through the model layer
 *    regardless of which ASR provider serves it) through an unsupported deep
 *    wildcard subpath (`./services/voice/transcript-store`) — brittle surface.
 *  - (c) is ~100 lines against the SHARED `Transcript` contract
 *    (@elizaos/shared/transcripts), which both the write and read sides JSON
 *    round-trip. The record-shape golden test in
 *    `meeting-transcript-writer.test.ts` parses the persisted row with the
 *    same reader logic transcripts-routes uses, so drift fails loudly.
 *
 * Row shape (must stay byte-compatible with plugin-local-inference's
 * TranscriptStore): memory id = transcript id, table `"transcripts"`,
 * `metadata.type "custom"` / `metadata.source "transcript"`,
 * `content.transcript` = JSON of the full record, `content.text` = preview.
 * The knowledge mirror goes through `runtime.getService("documents")
 * .addDocument` with the transcript-knowledge payload (tag `"transcript"`,
 * `clientDocumentId` = transcript id, `textBacked: true`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  logger,
  type Memory,
  type MemoryMetadata,
  resolveStateDir,
  type UUID,
} from "@elizaos/core";
import type {
  MeetingEndReason,
  MeetingParticipant,
  MeetingPlatform,
} from "@elizaos/shared";
import {
  type Transcript,
  type TranscriptSegment,
  transcriptDurationMs,
  transcriptPlainText,
  transcriptPreview,
  transcriptSpeakerCount,
} from "@elizaos/shared/transcripts";

/** The `type` column partition transcripts live in (sibling to "messages"). */
export const TRANSCRIPTS_TABLE = "transcripts";
/** `metadata.source` marker — matches plugin-local-inference's store. */
export const TRANSCRIPT_METADATA_TYPE = "transcript";
/** Tag every mirrored transcript carries so it's filterable as a transcript. */
export const TRANSCRIPT_DOCUMENT_TAG = "transcript";

/** Default milliseconds between incremental segment flushes to the store. */
export const DEFAULT_WRITE_THROTTLE_MS = 5_000;

/** The subset of `IAgentRuntime` the writer needs (real runtime satisfies it). */
export interface MeetingTranscriptRuntime {
  agentId: UUID;
  createMemory(memory: Memory, tableName: string): Promise<UUID>;
  getMemoryById(id: UUID): Promise<Memory | null>;
  updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
  ): Promise<boolean>;
  getService(name: string): unknown;
}

/** The documents/knowledge service surface the mirror needs (structural). */
interface DocumentsLike {
  addDocument(options: {
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    clientDocumentId: UUID;
    contentType: string;
    originalFilename: string;
    content: string;
    scope?: string;
    addedFrom?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ storedDocumentMemoryId: UUID }>;
}

export interface StartMeetingTranscriptInput {
  sessionId: UUID;
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
  title: string;
  platform: MeetingPlatform;
  meetingUrl: string;
  nativeMeetingId: string;
}

export interface FinalizeMeetingTranscriptInput {
  segments: TranscriptSegment[];
  endReason: MeetingEndReason;
  participants: MeetingParticipant[];
  /** Retained session audio (mono PCM16 WAV) — persisted to the media store. */
  audioWav?: Buffer | null;
}

/** Serialize a transcript into the exact memory row the Transcripts view reads. */
function transcriptContentAndMetadata(transcript: Transcript): {
  content: Memory["content"];
  metadata: MemoryMetadata;
} {
  return {
    content: {
      text: transcriptPreview(transcript.segments),
      transcript: JSON.stringify(transcript),
    },
    metadata: {
      type: "custom",
      source: TRANSCRIPT_METADATA_TYPE,
      timestamp: transcript.createdAt,
      transcriptId: transcript.id,
      durationMs: transcript.durationMs,
      speakerCount: transcript.speakerCount,
      status: transcript.status,
    },
  };
}

/**
 * Parse the stored {@link Transcript} back out of a memory row — the exact
 * reader logic plugin-local-inference's transcripts-routes uses
 * (`rowToTranscript`), duplicated here so the record-shape golden test and the
 * GET_MEETING_TRANSCRIPT action read rows the same way the view does.
 */
export function readTranscriptRow(row: Memory): Transcript | null {
  const raw = (row.content as { transcript?: unknown }).transcript;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Transcript) : null;
  } catch {
    return null;
  }
}

/**
 * Persist mono PCM16 WAV bytes into the content-addressed media store dir the
 * agent already serves at `/api/media/<sha256>.wav` (same mechanism as
 * plugin-local-inference's transcript-audio-store). Idempotent.
 */
export function persistMeetingAudioWav(wav: Buffer): string {
  const hash = createHash("sha256").update(wav).digest("hex");
  const dir = join(resolveStateDir(), "media");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${hash}.wav`);
  if (!existsSync(file)) writeFileSync(file, wav);
  return `/api/media/${hash}.wav`;
}

/**
 * Lifecycle writer for ONE meeting's transcript record: create at session
 * start with status `"recording"`, throttled incremental segment updates while
 * the meeting runs, and a final `"ready"` write with endedAt/duration/speaker
 * metadata + the knowledge mirror.
 */
export class MeetingTranscriptWriter {
  readonly transcriptId: UUID;
  private transcript: Transcript | null = null;
  private input: StartMeetingTranscriptInput | null = null;
  private segments: TranscriptSegment[] = [];
  private lastWriteAt = 0;
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;

  constructor(
    private readonly runtime: MeetingTranscriptRuntime,
    private readonly throttleMs: number = DEFAULT_WRITE_THROTTLE_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.transcriptId = crypto.randomUUID() as UUID;
  }

  /** Create the transcript record in status "recording". */
  async start(input: StartMeetingTranscriptInput): Promise<Transcript> {
    const createdAt = this.now();
    const transcript: Transcript = {
      id: this.transcriptId,
      title: input.title,
      createdAt,
      durationMs: 0,
      segments: [],
      source: "meeting",
      scope: "owner-private",
      status: "recording",
      speakerCount: 0,
      metadata: {
        platform: input.platform,
        meetingUrl: input.meetingUrl,
        nativeMeetingId: input.nativeMeetingId,
        sessionId: input.sessionId,
        participants: [],
        capture: { mode: "bot" },
        policy: { state: "allowed" },
        permission: { state: "not_required" },
        retention: {
          state: "transcript_only",
          sourceAudioDeleted: false,
        },
        sharing: {
          transcript: "owner_private",
          notes: "owner_private",
          sourceAudio: "disabled",
          artifacts: "owner_private",
        },
      },
    };
    const { content, metadata } = transcriptContentAndMetadata(transcript);
    await this.runtime.createMemory(
      {
        id: this.transcriptId,
        entityId: input.entityId,
        roomId: input.roomId,
        agentId: this.runtime.agentId,
        createdAt,
        content,
        metadata,
      },
      TRANSCRIPTS_TABLE,
    );
    this.transcript = transcript;
    this.input = input;
    this.lastWriteAt = createdAt;
    logger.info(
      { transcriptId: this.transcriptId, sessionId: input.sessionId },
      "[MeetingService] meeting transcript record created (recording)",
    );
    return transcript;
  }

  /**
   * Replace the live segment set (confirmed + pending tail) and schedule a
   * throttled store update — at most one write per `throttleMs`.
   */
  updateSegments(segments: TranscriptSegment[]): void {
    if (this.finalized || !this.transcript) return;
    this.segments = segments;
    const elapsed = this.now() - this.lastWriteAt;
    if (elapsed >= this.throttleMs) {
      void this.flush();
      return;
    }
    if (this.pendingFlush === null) {
      this.pendingFlush = setTimeout(() => {
        this.pendingFlush = null;
        void this.flush();
      }, this.throttleMs - elapsed);
      // Never keep the process alive for a throttle timer.
      this.pendingFlush.unref?.();
    }
  }

  /**
   * Incremental store write. Invoked via `void this.flush()` (fire-and-forget)
   * from the throttle path, so it must never reject — a DB hiccup would surface
   * as an unhandled promise rejection. All failures are caught and logged here;
   * the next update simply retries.
   */
  private async flush(): Promise<void> {
    if (this.finalized || !this.transcript) return;
    this.lastWriteAt = this.now();
    const next: Transcript = {
      ...this.transcript,
      segments: this.segments,
      durationMs: transcriptDurationMs(this.segments),
      speakerCount: transcriptSpeakerCount(this.segments),
    };
    this.transcript = next;
    const { content, metadata } = transcriptContentAndMetadata(next);
    try {
      const ok = await this.runtime.updateMemory({
        id: this.transcriptId,
        content,
        metadata,
      });
      if (!ok) {
        logger.warn(
          {
            transcriptId: this.transcriptId,
            sessionId: this.input?.sessionId,
          },
          "[MeetingService] incremental transcript update hit a missing row",
        );
      }
    } catch (err) {
      logger.warn(
        {
          transcriptId: this.transcriptId,
          sessionId: this.input?.sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
        "[MeetingService] incremental transcript update failed",
      );
    }
  }

  /** Final write: status "ready", timings, participants, audio + knowledge mirror. */
  async finalize(input: FinalizeMeetingTranscriptInput): Promise<Transcript> {
    if (!this.transcript || !this.input) {
      throw new Error(
        "[MeetingService] finalize called before transcript start",
      );
    }
    if (this.finalized) return this.transcript;
    this.finalized = true;
    if (this.pendingFlush !== null) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }

    const endedAt = this.now();
    let audioUrl: string | undefined;
    let audioContentType: string | undefined;
    if (input.audioWav && input.audioWav.length > 0) {
      audioUrl = persistMeetingAudioWav(input.audioWav);
      audioContentType = "audio/wav";
    }

    const final: Transcript = {
      ...this.transcript,
      segments: input.segments,
      endedAt,
      durationMs: transcriptDurationMs(input.segments),
      speakerCount: transcriptSpeakerCount(input.segments),
      status: "ready",
      audioUrl,
      audioContentType,
      metadata: {
        ...this.transcript.metadata,
        endReason: input.endReason,
        participants: input.participants,
        retention: {
          state: audioUrl ? "audio_retained" : "transcript_only",
          sourceAudioDeleted: false,
        },
        sharing: {
          transcript: "owner_private",
          notes: "owner_private",
          sourceAudio: audioUrl ? "owner_private" : "disabled",
          artifacts: "owner_private",
        },
      },
    };

    const knowledgeDocumentId = await this.mirrorToKnowledge(final);
    if (knowledgeDocumentId) final.knowledgeDocumentId = knowledgeDocumentId;
    this.transcript = final;

    const { content, metadata } = transcriptContentAndMetadata(final);
    const ok = await this.runtime.updateMemory({
      id: this.transcriptId,
      content,
      metadata,
    });
    if (!ok) {
      throw new Error(
        `[MeetingService] transcript ${this.transcriptId} row vanished before finalize`,
      );
    }
    logger.info(
      {
        transcriptId: this.transcriptId,
        segments: final.segments.length,
        durationMs: final.durationMs,
        speakerCount: final.speakerCount,
        endReason: input.endReason,
      },
      "[MeetingService] meeting transcript finalized (ready)",
    );
    return final;
  }

  /**
   * Best-effort searchable mirror into the documents/knowledge store — a
   * search-index failure must never lose the meeting record.
   */
  private async mirrorToKnowledge(
    transcript: Transcript,
  ): Promise<string | undefined> {
    const documents = this.runtime.getService(
      "documents",
    ) as DocumentsLike | null;
    if (!documents || !this.input) return undefined;
    const content = transcriptPlainText(transcript.segments);
    if (!content) return undefined;
    const slug =
      transcript.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "transcript";
    try {
      const res = await documents.addDocument({
        worldId: this.input.worldId,
        roomId: this.input.roomId,
        entityId: this.input.entityId,
        clientDocumentId: transcript.id as UUID,
        contentType: "text/plain",
        originalFilename: `${slug}.txt`,
        content,
        scope: transcript.scope,
        addedFrom: "runtime-internal",
        metadata: {
          source: TRANSCRIPT_DOCUMENT_TAG,
          tags: [TRANSCRIPT_DOCUMENT_TAG],
          transcriptId: transcript.id,
          title: transcript.title,
          durationMs: transcript.durationMs,
          speakerCount: transcript.speakerCount,
          createdAt: transcript.createdAt,
          textBacked: true,
          // `mediaUrl` is the key the daily media GC scans on document rows;
          // `audioUrl` alone would leave the retained WAV unreferenced and it
          // would be swept. Set both: mediaUrl anchors the media store handle,
          // audioUrl is what transcript readers look up.
          ...(transcript.audioUrl
            ? {
                mediaUrl: transcript.audioUrl,
                audioUrl: transcript.audioUrl,
              }
            : {}),
        },
      });
      return res.storedDocumentMemoryId;
    } catch (err) {
      logger.warn(
        {
          transcriptId: transcript.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "[MeetingService] transcript knowledge mirror failed",
      );
      return undefined;
    }
  }
}
