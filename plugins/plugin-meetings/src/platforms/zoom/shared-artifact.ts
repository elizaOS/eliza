/**
 * Shared MeetingArtifact projection for the real Zoom browser-bot capture
 * path. The retained session WAV is a mixed stream, so the artifact records
 * that source loss explicitly instead of claiming per-participant audio.
 */

import {
  assertValidMeetingArtifact,
  MEETING_ARTIFACT_SCHEMA_VERSION,
  type MeetingArtifact,
  type MeetingParticipant,
} from "@elizaos/shared";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";

export interface ZoomBotMeetingArtifactInput {
  artifactId: string;
  meetingId: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  participants: readonly MeetingParticipant[];
  segments: readonly TranscriptSegment[];
  audio: {
    id: string;
    url: string;
    checksum: string;
    mimeType: "audio/wav";
  };
}

export function buildZoomBotMeetingArtifact(
  input: ZoomBotMeetingArtifactInput,
): MeetingArtifact {
  const streamId = `zoom-bot-mixed:${input.meetingId}`;
  const participantByName = new Map(
    input.participants.map((participant) => [
      participant.displayName.trim().toLowerCase(),
      participant,
    ]),
  );
  const speakerRows = new Map<
    string,
    { label: string; participant?: MeetingParticipant }
  >();
  const transcriptSpans = input.segments.map((segment) => {
    const label = segment.speakerLabel?.trim();
    const participant = label
      ? participantByName.get(label.toLowerCase())
      : undefined;
    const speakerId = label ? `zoom-speaker:${stableLabel(label)}` : undefined;
    if (speakerId && label) speakerRows.set(speakerId, { label, participant });
    return {
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      words: segment.words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        confidence: word.confidence,
        speakerId,
        sourceStreamId: streamId,
      })),
      speakerId,
      platformParticipantId: participant?.id,
      sourceStreamId: streamId,
      confidence: segment.confidence,
    };
  });
  const diarizedSpeakers = [...speakerRows].map(
    ([id, { label, participant }]) => ({
      id,
      sourceStreamIds: [streamId],
      platformParticipantIds: participant ? [participant.id] : undefined,
      entityBindingId: participant?.entityId
        ? `zoom-binding:${participant.entityId}`
        : undefined,
      name: {
        displayName: label,
        provenance: "platform" as const,
        confidence: 1,
      },
      status: "active" as const,
    }),
  );
  const entityBindings = [...speakerRows]
    .filter(([, row]) => row.participant?.entityId)
    .map(([diarizedSpeakerId, row]) => ({
      id: `zoom-binding:${row.participant?.entityId}`,
      diarizedSpeakerId,
      entityId: row.participant?.entityId ?? null,
      status: "active" as const,
      confidence: 1,
      provenance: "platform" as const,
    }));
  const artifact: MeetingArtifact = {
    schemaVersion: MEETING_ARTIFACT_SCHEMA_VERSION,
    artifactId: input.artifactId,
    meeting: {
      id: input.meetingId,
      nativeMeetingId: input.meetingId,
      platform: "zoom",
      captureMode: "platform_bot",
      title: input.title,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      consent: { state: "unknown" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    media: [
      {
        id: input.audio.id,
        url: input.audio.url,
        checksum: input.audio.checksum,
        mimeType: input.audio.mimeType,
        title: "Zoom browser-bot mixed session audio",
      },
    ],
    sourceStreams: [
      {
        id: streamId,
        kind: "recording",
        mediaRefId: input.audio.id,
        label: "mixed_audio_only; per_participant_audio_unavailable",
      },
    ],
    platformParticipants: input.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      joinedAtMs: participant.joinedAtMs,
      leftAtMs: participant.leftAtMs,
    })),
    diarizedSpeakers,
    entityBindings,
    transcriptSpans,
    notes: [],
    actionItems: [],
    decisions: [],
    evidenceArtifacts: [
      {
        id: `zoom-source-loss:${input.meetingId}`,
        kind: "metrics",
        mediaRefId: input.audio.id,
        transcriptSpanIds:
          transcriptSpans.length > 0
            ? transcriptSpans.map((span) => span.id)
            : undefined,
        description:
          "Zoom browser capture retained mixed audio; per-participant audio was unavailable.",
      },
    ],
    provenance: {
      createdAt: input.endedAt,
      generator: "@elizaos/plugin-meetings/zoom-browser-bot",
    },
  };
  assertValidMeetingArtifact(artifact);
  return artifact;
}

function stableLabel(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase()) || "unknown";
}
