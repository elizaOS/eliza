/** Synthetic meeting artifacts for owner-package regression tests. */
import {
  MEETING_ARTIFACT_SCHEMA_VERSION,
  type MeetingArtifact,
  type MeetingArtifactMediaRef,
  type MeetingArtifactWord,
} from "@elizaos/core/protocol";

function media(id: string, mimeType = "audio/wav"): MeetingArtifactMediaRef {
  return {
    id,
    url: `/api/media/${"a".repeat(64)}.${mimeType === "audio/wav" ? "wav" : "json"}`,
    mimeType,
    checksum: "a".repeat(64),
  };
}

function word(
  text: string,
  startMs: number,
  endMs: number,
): MeetingArtifactWord {
  return { text, startMs, endMs, confidence: 0.98 };
}

function baseArtifact(overrides: Partial<MeetingArtifact>): MeetingArtifact {
  return {
    schemaVersion: MEETING_ARTIFACT_SCHEMA_VERSION,
    artifactId: "meeting-artifact-fixture",
    meeting: {
      id: "meeting-fixture",
      platform: "google_meet",
      captureMode: "platform_bot",
      consent: { state: "granted", evidence: "calendar invite" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    media: [media("media-main")],
    sourceStreams: [
      {
        id: "stream-main",
        kind: "mixed_room_mic",
        mediaRefId: "media-main",
        platformParticipantId: "tile-room",
      },
    ],
    platformParticipants: [{ id: "tile-room", displayName: "Room 12" }],
    diarizedSpeakers: [],
    entityBindings: [],
    transcriptSpans: [],
    notes: [],
    actionItems: [],
    decisions: [],
    evidenceArtifacts: [],
    ...overrides,
  };
}

export function buildMeetingArtifactFixtures(): Record<
  string,
  MeetingArtifact
> {
  const googleMeetRoom = baseArtifact({
    artifactId: "meet-room-three-speakers",
    diarizedSpeakers: [1, 2, 3].map((index) => ({
      id: `speaker-${index}`,
      sourceStreamIds: ["stream-main"],
      platformParticipantIds: ["tile-room"],
      name: {
        displayName: `Room speaker ${index}`,
        provenance: index === 1 ? "platform" : "unknown",
        confidence: index === 1 ? 0.7 : 0,
      },
      status: index === 3 ? "unknown" : "active",
    })),
    transcriptSpans: [1, 2, 3].map((index) => ({
      id: `span-${index}`,
      startMs: (index - 1) * 1000,
      endMs: index * 1000,
      text: `speaker ${index} update`,
      words: [word("speaker", (index - 1) * 1000, (index - 1) * 1000 + 400)],
      speakerId: `speaker-${index}`,
      platformParticipantId: "tile-room",
      sourceStreamId: "stream-main",
    })),
    notes: [
      {
        id: "note-1",
        text: "Three speakers shared one tile.",
        transcriptSpanIds: ["span-1"],
      },
    ],
  });

  const zoomPerParticipant = baseArtifact({
    artifactId: "zoom-per-participant",
    meeting: {
      id: "zoom-fixture",
      platform: "zoom",
      nativeMeetingId: "123456789",
      captureMode: "platform_bot",
      consent: { state: "granted" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    media: [media("media-alice"), media("media-bob")],
    sourceStreams: [
      {
        id: "stream-alice",
        kind: "bot_participant_audio",
        mediaRefId: "media-alice",
        platformParticipantId: "zoom-alice",
      },
      {
        id: "stream-bob",
        kind: "bot_participant_audio",
        mediaRefId: "media-bob",
        platformParticipantId: "zoom-bob",
      },
    ],
    platformParticipants: [
      { id: "zoom-alice", displayName: "Alice" },
      { id: "zoom-bob", displayName: "Bob" },
    ],
    diarizedSpeakers: [
      {
        id: "speaker-alice",
        sourceStreamIds: ["stream-alice"],
        platformParticipantIds: ["zoom-alice"],
        entityBindingId: "binding-alice",
        name: {
          displayName: "Alice",
          provenance: "platform",
          confidence: 0.95,
        },
      },
      {
        id: "speaker-bob",
        sourceStreamIds: ["stream-bob"],
        platformParticipantIds: ["zoom-bob"],
        entityBindingId: "binding-bob",
        name: { displayName: "Bob", provenance: "calendar", confidence: 0.9 },
      },
    ],
    entityBindings: [
      {
        id: "binding-alice",
        diarizedSpeakerId: "speaker-alice",
        entityId: "entity-alice",
        status: "active",
        confidence: 0.95,
        provenance: "voice_profile",
      },
      {
        id: "binding-bob",
        diarizedSpeakerId: "speaker-bob",
        entityId: "entity-bob",
        status: "active",
        confidence: 0.9,
        provenance: "calendar",
      },
    ],
    transcriptSpans: [
      {
        id: "span-alice",
        startMs: 0,
        endMs: 900,
        text: "hello bob",
        words: [word("hello", 0, 400), word("bob", 450, 900)],
        speakerId: "speaker-alice",
        platformParticipantId: "zoom-alice",
        sourceStreamId: "stream-alice",
      },
    ],
  });

  const inPersonRoomMic = baseArtifact({
    artifactId: "in-person-room-mic",
    meeting: {
      id: "room-fixture",
      platform: "local",
      captureMode: "local_capture",
      consent: { state: "not_required" },
      retentionPolicy: {
        retainAudio: true,
        retainTranscript: true,
        scope: "owner-private",
      },
    },
    platformParticipants: [],
    sourceStreams: [
      { id: "room-mic", kind: "mixed_room_mic", mediaRefId: "media-main" },
    ],
    diarizedSpeakers: [
      {
        id: "room-speaker",
        sourceStreamIds: ["room-mic"],
        name: {
          displayName: "Unknown speaker",
          provenance: "unknown",
          confidence: 0,
        },
        status: "unknown",
      },
    ],
    transcriptSpans: [
      {
        id: "room-span",
        startMs: 0,
        endMs: 1000,
        text: "unattributed room speech",
        words: [word("unattributed", 0, 500)],
        speakerId: "room-speaker",
        sourceStreamId: "room-mic",
        overlap: true,
      },
    ],
  });

  const importedCorpus = baseArtifact({
    artifactId: "imported-corpus-ami-style",
    meeting: {
      id: "ami-fixture",
      platform: "imported_corpus",
      captureMode: "imported_corpus",
      consent: { state: "not_required", evidence: "research corpus license" },
      retentionPolicy: {
        retainAudio: false,
        retainTranscript: true,
        scope: "agent-private",
      },
    },
    sourceStreams: [
      {
        id: "corpus-audio",
        kind: "imported_corpus_audio",
        mediaRefId: "media-main",
      },
    ],
    diarizedSpeakers: [
      {
        id: "corpus-speaker",
        sourceStreamIds: ["corpus-audio"],
        name: {
          displayName: "Corpus speaker A",
          provenance: "self_introduction",
          confidence: 0.8,
        },
      },
    ],
    transcriptSpans: [
      {
        id: "corpus-span",
        startMs: 0,
        endMs: 1200,
        text: "corpus transcript",
        words: [word("corpus", 0, 500), word("transcript", 550, 1200)],
        speakerId: "corpus-speaker",
        sourceStreamId: "corpus-audio",
      },
    ],
    evidenceArtifacts: [
      {
        id: "license",
        kind: "benchmark_report",
        mediaRefId: "media-main",
        description: "License/citation manifest",
      },
    ],
    provenance: {
      benchmarkCorpus: "AMI-style fixture",
      license: "fixture-only",
      citation: "Synthetic fixture for schema validation",
    },
  });

  const oneSpeakerAcrossStreams = baseArtifact({
    artifactId: "one-speaker-across-streams",
    media: [media("media-local"), media("media-system")],
    sourceStreams: [
      { id: "local-mic", kind: "local_mic", mediaRefId: "media-local" },
      { id: "system-audio", kind: "system_audio", mediaRefId: "media-system" },
    ],
    diarizedSpeakers: [
      {
        id: "speaker-moving",
        sourceStreamIds: ["local-mic", "system-audio"],
        entityBindingId: "binding-moving",
        name: {
          displayName: "Dana",
          provenance: "voice_profile",
          confidence: 0.91,
        },
      },
    ],
    entityBindings: [
      {
        id: "binding-moving",
        diarizedSpeakerId: "speaker-moving",
        entityId: "entity-dana",
        status: "active",
        confidence: 0.91,
        provenance: "voice_profile",
      },
    ],
    transcriptSpans: [
      {
        id: "span-local",
        startMs: 0,
        endMs: 900,
        text: "local mic speech",
        words: [word("local", 0, 350)],
        speakerId: "speaker-moving",
        sourceStreamId: "local-mic",
      },
      {
        id: "span-system",
        startMs: 1000,
        endMs: 1800,
        text: "system audio speech",
        words: [word("system", 1000, 1350)],
        speakerId: "speaker-moving",
        sourceStreamId: "system-audio",
      },
    ],
  });

  return {
    googleMeetRoom,
    zoomPerParticipant,
    inPersonRoomMic,
    importedCorpus,
    oneSpeakerAcrossStreams,
  };
}
