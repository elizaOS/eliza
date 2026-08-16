import { describe, expect, it } from "vitest";
import {
  assertValidMeetingArtifact,
  buildMeetingArtifactFixtures,
  MEETING_ARTIFACT_SCHEMA_VERSION,
  type MeetingArtifact,
  meetingArtifactToTranscriptSegments,
  validateMeetingArtifact,
} from "./meeting-artifacts.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function at<T>(rows: T[], index: number, label: string): T {
  const value = rows[index];
  if (!value) throw new Error(`missing ${label}[${index}] test fixture`);
  return value;
}

const durableRecordKeys = [
  "notes",
  "actionItems",
  "decisions",
  "evidenceArtifacts",
] as const;

type DurableRecordKey = (typeof durableRecordKeys)[number];

function setDurableRecordIds(
  artifact: MeetingArtifact,
  key: DurableRecordKey,
  ids: string[],
  transcriptSpanId: string,
): void {
  if (key === "evidenceArtifacts") {
    artifact.evidenceArtifacts = ids.map((id) => ({
      id,
      kind: "log",
      transcriptSpanIds: [transcriptSpanId],
    }));
    return;
  }

  artifact[key] = ids.map((id) => ({
    id,
    text: "Follow up",
    transcriptSpanIds: [transcriptSpanId],
  }));
}

describe("meeting artifact fixtures", () => {
  it("ships valid sample artifacts for platform, room, and corpus capture modes", () => {
    const fixtures = buildMeetingArtifactFixtures();
    expect(Object.keys(fixtures).sort()).toEqual([
      "googleMeetRoom",
      "importedCorpus",
      "inPersonRoomMic",
      "oneSpeakerAcrossStreams",
      "zoomPerParticipant",
    ]);

    for (const artifact of Object.values(fixtures)) {
      expect(artifact.schemaVersion).toBe(MEETING_ARTIFACT_SCHEMA_VERSION);
      expect(validateMeetingArtifact(artifact)).toEqual({
        valid: true,
        errors: [],
      });
      expect(() => assertValidMeetingArtifact(artifact)).not.toThrow();
    }
  });

  it("preserves multiple diarized speakers on one Google Meet platform tile", () => {
    const artifact = buildMeetingArtifactFixtures().googleMeetRoom;
    const tileIds = new Set(
      artifact.diarizedSpeakers.flatMap(
        (speaker) => speaker.platformParticipantIds ?? [],
      ),
    );

    expect(tileIds).toEqual(new Set(["tile-room"]));
    expect(artifact.diarizedSpeakers).toHaveLength(3);
    expect(artifact.platformParticipants).toEqual([
      { id: "tile-room", displayName: "Room 12" },
    ]);
  });

  it("supports one diarized speaker moving across source streams", () => {
    const artifact = buildMeetingArtifactFixtures().oneSpeakerAcrossStreams;
    const [speaker] = artifact.diarizedSpeakers;

    expect(speaker.sourceStreamIds).toEqual(["local-mic", "system-audio"]);
    expect(validateMeetingArtifact(artifact).valid).toBe(true);
  });

  it("projects canonical spans into TranscriptSegment rows for knowledge mirroring", () => {
    const artifact = buildMeetingArtifactFixtures().zoomPerParticipant;
    const segments = meetingArtifactToTranscriptSegments(artifact);

    expect(segments).toEqual([
      {
        id: "span-alice",
        speakerLabel: "Alice",
        speakerEntityId: "entity-alice",
        startMs: 0,
        endMs: 900,
        text: "hello bob",
        words: [
          { text: "hello", startMs: 0, endMs: 400, confidence: 0.98 },
          { text: "bob", startMs: 450, endMs: 900, confidence: 0.98 },
        ],
        confidence: undefined,
      },
    ]);
  });
});

describe("validateMeetingArtifact", () => {
  it("accepts unknown speakers without forcing an entity binding", () => {
    const artifact = buildMeetingArtifactFixtures().inPersonRoomMic;
    expect(artifact.diarizedSpeakers[0]?.status).toBe("unknown");
    expect(artifact.entityBindings).toEqual([]);
    expect(validateMeetingArtifact(artifact).valid).toBe(true);
  });

  it("accepts user-corrected renamed speakers and correction history", () => {
    const artifact = clone(buildMeetingArtifactFixtures().zoomPerParticipant);
    at(artifact.diarizedSpeakers, 0, "diarizedSpeakers").name = {
      displayName: "Alicia",
      provenance: "user_correction",
      confidence: 1,
      evidenceSpanIds: ["span-alice"],
    };
    at(artifact.transcriptSpans, 0, "transcriptSpans").correctionHistory = [
      {
        atMs: 950,
        correctedByEntityId: "owner",
        previousSpeakerId: "speaker-alice",
        reason: "rename",
      },
    ];

    expect(validateMeetingArtifact(artifact)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("accepts merged, split, and deleted profile binding lifecycle states", () => {
    const artifact = clone(buildMeetingArtifactFixtures().zoomPerParticipant);
    artifact.entityBindings = [
      {
        id: "binding-merged",
        diarizedSpeakerId: "speaker-alice",
        entityId: "entity-old-alice",
        status: "merged",
        confidence: 0.8,
        provenance: "user_correction",
        mergedIntoEntityId: "entity-alice",
      },
      {
        id: "binding-split",
        diarizedSpeakerId: "speaker-bob",
        entityId: "entity-bob-new",
        status: "split",
        confidence: 0.7,
        provenance: "user_correction",
        splitFromEntityId: "entity-bob-old",
      },
      {
        id: "binding-deleted",
        diarizedSpeakerId: "speaker-bob",
        entityId: null,
        status: "deleted",
        confidence: 0,
        provenance: "user_correction",
        deletedAt: "2026-07-04T00:00:00.000Z",
      },
    ];
    at(artifact.diarizedSpeakers, 0, "diarizedSpeakers").entityBindingId =
      "binding-merged";
    at(artifact.diarizedSpeakers, 1, "diarizedSpeakers").entityBindingId =
      "binding-split";

    expect(validateMeetingArtifact(artifact).valid).toBe(true);
  });

  it("rejects transcript spans that reference missing speakers", () => {
    const artifact = clone(buildMeetingArtifactFixtures().zoomPerParticipant);
    at(artifact.transcriptSpans, 0, "transcriptSpans").speakerId =
      "speaker-missing";

    expect(validateMeetingArtifact(artifact).errors).toContain(
      "transcriptSpans[0].speakerId references missing speaker",
    );
  });

  it("rejects missing media refs instead of creating a second file store", () => {
    const artifact = clone(buildMeetingArtifactFixtures().zoomPerParticipant);
    at(artifact.sourceStreams, 0, "sourceStreams").mediaRefId = "file-123";

    expect(validateMeetingArtifact(artifact).errors).toContain(
      "sourceStreams[0].mediaRefId references missing media",
    );
  });

  it("rejects legacy fileId fields and non-media-store URLs", () => {
    const artifact = clone(
      buildMeetingArtifactFixtures().zoomPerParticipant,
    ) as MeetingArtifact & {
      media: Array<MeetingArtifact["media"][number] & { fileId?: string }>;
    };
    at(artifact.media, 0, "media").fileId = "legacy-file-id";
    at(artifact.media, 0, "media").url = "https://example.com/audio.wav";

    const errors = validateMeetingArtifact(artifact).errors;
    expect(errors).toContain(
      "media[0] must not define fileId; use Media.id/url",
    );
    expect(errors).toContain(
      "media[0].url must be a content-addressed /api/media URL",
    );
  });

  it("rejects ungrounded notes/action items/decisions", () => {
    const artifact = clone(buildMeetingArtifactFixtures().googleMeetRoom);
    artifact.actionItems = [
      {
        id: "action-1",
        text: "Follow up",
        transcriptSpanIds: ["span-missing"],
      },
    ];
    artifact.decisions = [
      {
        id: "decision-1",
        text: "Ship it",
        transcriptSpanIds: ["span-missing"],
      },
    ];

    const errors = validateMeetingArtifact(artifact).errors;
    expect(errors).toContain(
      "actionItems[0].transcriptSpanIds[0] references missing id: span-missing",
    );
    expect(errors).toContain(
      "decisions[0].transcriptSpanIds[0] references missing id: span-missing",
    );
  });

  it.each(durableRecordKeys)(
    "rejects %s records without durable ids",
    (key) => {
      const artifact = clone(buildMeetingArtifactFixtures().googleMeetRoom);
      const transcriptSpan = at(artifact.transcriptSpans, 0, "transcriptSpans");
      setDurableRecordIds(artifact, key, [""], transcriptSpan.id);

      expect(validateMeetingArtifact(artifact).errors).toContain(
        `${key}[0].id is required`,
      );
    },
  );

  it.each(durableRecordKeys)("rejects duplicate %s record ids", (key) => {
    const artifact = clone(buildMeetingArtifactFixtures().googleMeetRoom);
    const transcriptSpan = at(artifact.transcriptSpans, 0, "transcriptSpans");
    setDurableRecordIds(
      artifact,
      key,
      ["duplicate-id", "duplicate-id"],
      transcriptSpan.id,
    );

    expect(validateMeetingArtifact(artifact).errors).toContain(
      `duplicate ${key} id: duplicate-id`,
    );
  });
});
