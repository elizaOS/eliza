/**
 * Contract tests for the real Zoom browser-bot capture projection into the
 * shared MeetingArtifact schema, including source-loss and entity provenance.
 */

import { validateMeetingArtifact } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { buildZoomBotMeetingArtifact } from "../shared-artifact.js";

describe("Zoom browser-bot shared artifact", () => {
  it("preserves transcript timing and labels mixed-audio source loss", () => {
    const checksum = "a".repeat(64);
    const artifact = buildZoomBotMeetingArtifact({
      artifactId: "zoom-bot:session-1",
      meetingId: "123456789",
      title: "Zoom roadmap",
      participants: [
        {
          id: "participant-alice",
          displayName: "Alice",
          entityId: "entity-alice",
        },
      ],
      segments: [
        {
          id: "span-1",
          speakerLabel: "Alice",
          startMs: 100,
          endMs: 900,
          text: "Ship it.",
          words: [{ text: "Ship", startMs: 100, endMs: 400 }],
        },
      ],
      audio: {
        id: checksum,
        checksum,
        url: `/api/media/${checksum}.wav`,
        mimeType: "audio/wav",
      },
    });

    expect(validateMeetingArtifact(artifact)).toEqual({
      valid: true,
      errors: [],
    });
    expect(artifact.sourceStreams[0]?.label).toContain("mixed_audio_only");
    expect(artifact.transcriptSpans[0]).toMatchObject({
      speakerId: "zoom-speaker:alice",
      platformParticipantId: "participant-alice",
      startMs: 100,
      endMs: 900,
    });
    expect(artifact.entityBindings[0]).toMatchObject({
      entityId: "entity-alice",
      provenance: "platform",
    });
    expect(artifact.evidenceArtifacts[0]?.description).toContain(
      "per-participant audio was unavailable",
    );
  });
});
