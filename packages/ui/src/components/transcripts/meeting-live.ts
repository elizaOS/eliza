/**
 * Live meeting transcript state (#11856) — pure reducer + metadata readers
 * behind the Transcripts view's live pane. Kept prop/data-driven so the merge
 * semantics ("confirmed appends, pending replaces") are unit-testable without
 * a WebSocket or the data layer.
 */

import type {
  MeetingParticipant,
  MeetingPlatform,
  MeetingTranscriptEvent,
} from "@elizaos/shared";
import { MEETING_PLATFORMS } from "@elizaos/shared";
import type {
  Transcript,
  TranscriptSegment,
} from "@elizaos/shared/transcripts";

/** The live pane's view of an in-progress meeting transcript. */
export interface LiveTranscriptState {
  /** Stable, LocalAgreement-confirmed segments (append-only). */
  confirmed: TranscriptSegment[];
  /** Mutable ASR tail — replaced wholesale by every event/poll. */
  pending: TranscriptSegment[];
}

export const EMPTY_LIVE_TRANSCRIPT: LiveTranscriptState = {
  confirmed: [],
  pending: [],
};

/**
 * Apply one `meeting-transcript` ws event: append the confirmed segments the
 * pane hasn't seen yet (deduped by segment id, so replays/backlog are safe)
 * and replace the pending tail.
 */
export function applyMeetingTranscriptEvent(
  state: LiveTranscriptState,
  event: MeetingTranscriptEvent,
): LiveTranscriptState {
  const seen = new Set(state.confirmed.map((s) => s.id));
  const appended = event.confirmed.filter((s) => !seen.has(s.id));
  return {
    confirmed:
      appended.length > 0 ? [...state.confirmed, ...appended] : state.confirmed,
    pending: event.pending,
  };
}

/**
 * Reconcile against a polled transcript record (the ws-unavailable fallback).
 * The server record is authoritative for confirmed segments; the poll carries
 * no pending tail, so any locally-held pending state is kept.
 */
export function applyPolledTranscript(
  state: LiveTranscriptState,
  transcript: Transcript,
): LiveTranscriptState {
  if (transcript.segments.length <= state.confirmed.length) return state;
  const confirmedIds = new Set(transcript.segments.map((s) => s.id));
  return {
    confirmed: transcript.segments,
    pending: state.pending.filter((s) => !confirmedIds.has(s.id)),
  };
}

function isMeetingPlatform(value: unknown): value is MeetingPlatform {
  return (
    typeof value === "string" &&
    (MEETING_PLATFORMS as readonly string[]).includes(value)
  );
}

/** Meeting-specific fields a meeting transcript carries in its metadata. */
export interface MeetingTranscriptMeta {
  platform: MeetingPlatform | null;
  participants: MeetingParticipant[];
}

/**
 * Read the meeting metadata off a transcript record (`metadata.platform`,
 * `metadata.participants`). Meaningful only for `source: "meeting"` records;
 * malformed/absent metadata degrades to no badge + empty roster.
 */
export function meetingTranscriptMeta(transcript: {
  source?: Transcript["source"];
  metadata?: Record<string, unknown>;
}): MeetingTranscriptMeta {
  const meta = transcript.metadata ?? {};
  const platform = isMeetingPlatform(meta.platform) ? meta.platform : null;
  const raw = meta.participants;
  const participants: MeetingParticipant[] = Array.isArray(raw)
    ? raw.filter(
        (p): p is MeetingParticipant =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as { displayName?: unknown }).displayName === "string",
      )
    : [];
  return { platform, participants };
}
