/**
 * Regression: `validateMeetingArtifact` must reject a `meeting.platform`
 * outside the `MeetingArtifactPlatform` union.
 *
 * Every other enum-typed meeting field is checked against its allowed
 * values (`captureMode`, `consent.state`), but `platform` was only
 * checked for non-emptiness, so an artifact claiming `platform: "skype"`
 * passed the canonical validation gate and could flow into storage and
 * UI code that switches on the known platforms.
 */

import { describe, expect, it } from "vitest";
import {
	type MeetingArtifact,
	validateMeetingArtifact,
} from "../src/meeting-artifacts";

function validArtifact(): MeetingArtifact {
	return {
		schemaVersion: "eliza.meeting_artifact.v1",
		artifactId: "artifact-1",
		meeting: {
			id: "meeting-1",
			platform: "zoom",
			captureMode: "platform_bot",
			consent: { state: "granted" },
			retentionPolicy: {
				retainAudio: true,
				retainTranscript: true,
				scope: "owner-private",
			},
		},
		media: [
			{
				id: "media-1",
				url: `/api/media/${"a".repeat(64)}.wav`,
				mimeType: "audio/wav",
			},
		],
		sourceStreams: [
			{ id: "stream-1", kind: "local_mic", mediaRefId: "media-1" },
		],
		platformParticipants: [],
		diarizedSpeakers: [{ id: "speaker-1", sourceStreamIds: ["stream-1"] }],
		entityBindings: [],
		transcriptSpans: [],
		notes: [],
		actionItems: [],
		decisions: [],
		evidenceArtifacts: [],
	};
}

describe("validateMeetingArtifact platform", () => {
	it.each([
		"google_meet",
		"teams",
		"zoom",
		"discord",
		"local",
		"imported_corpus",
		"unknown",
	] as const)("accepts platform %s", (platform) => {
		const artifact = validArtifact();
		artifact.meeting.platform = platform;
		expect(validateMeetingArtifact(artifact).valid).toBe(true);
	});

	it("rejects a platform outside the union", () => {
		const artifact = validArtifact();
		(artifact.meeting as { platform: string }).platform = "skype";
		const validation = validateMeetingArtifact(artifact);
		expect(validation.valid).toBe(false);
		expect(validation.errors.join("; ")).toContain("meeting.platform");
	});
});
