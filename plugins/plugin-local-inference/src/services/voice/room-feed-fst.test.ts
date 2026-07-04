/** Covers deterministic room-feed FST states, provenance gating, and transitions. */
import { describe, expect, it } from "vitest";
import {
	assertRoomFeedTransition,
	classifyRoomFeed,
	isRoomFeedTransitionAllowed,
	type RoomFeedState,
} from "./room-feed-fst";

describe("room-feed-fst", () => {
	it("classifies a single platform person as an individual feed", () => {
		const result = classifyRoomFeed({
			captureMode: "bot",
			platformParticipant: { id: "p1", kind: "person", displayName: "Ari" },
			sourceStream: { id: "s1", kind: "participant_audio" },
			diarizedSpeakerCount: 1,
			speakerCountConfidence: 0.9,
			visiblePersonCount: 1,
			faceCountConfidence: 0.88,
			activeSpeakerContinuity: 0.92,
		});

		expect(result.state).toBe("individual_feed_likely");
		expect(result.confidenceLevel).toBe("high");
		expect(result.requiresReview).toBe(false);
		expect(result.reasonCodes).toContain("single_speaker_single_face");
		expect(result.reasonCodes).toContain("participant_declared_person");
	});

	it("suspects a room feed from weak mixed-source evidence", () => {
		const result = classifyRoomFeed({
			captureMode: "system_audio",
			sourceStream: { id: "screen-audio", kind: "mixed_system_audio" },
			diarizedSpeakerCount: 2,
			speakerCountConfidence: 0.52,
			visiblePersonCount: 1,
			faceCountConfidence: 0.6,
		});

		expect(result.state).toBe("room_feed_suspected");
		expect(result.requiresReview).toBe(true);
		expect(result.reasonCodes).toContain("mixed_capture_source");
		expect(result.uiHints.map((hint) => hint.code)).toContain(
			"participant_may_represent_room",
		);
	});

	it("confirms a declared room participant", () => {
		const result = classifyRoomFeed({
			captureMode: "bot",
			platformParticipant: {
				id: "conf-room-1",
				kind: "room",
				isRoomResource: true,
			},
			sourceStream: { id: "room-feed", kind: "participant_audio" },
			diarizedSpeakerCount: 1,
			speakerCountConfidence: 0.82,
		});

		expect(result.state).toBe("room_feed_confirmed");
		expect(result.requiresReview).toBe(false);
		expect(result.reasonCodes).toContain("participant_declared_room");
	});

	it("classifies a room mic with matching audio and video counts as multi-speaker room", () => {
		const result = classifyRoomFeed({
			captureMode: "room_mic",
			sourceStream: { id: "room-mic", kind: "room_mic", isMixed: true },
			diarizedSpeakerCount: 3,
			speakerCountConfidence: 0.93,
			visiblePersonCount: 4,
			faceCountConfidence: 0.89,
			overlapRatio: 0.24,
		});

		expect(result.state).toBe("multi_speaker_room");
		expect(result.confidenceLevel).toBe("high");
		expect(result.reasonCodes).toContain("audio_visual_count_agree");
		expect(result.uiHints.map((hint) => hint.code)).toEqual([
			"participant_may_represent_room",
			"split_speaker_candidates",
		]);
	});

	it("keeps a declared room with multiple diarized speakers in the multi-speaker room state", () => {
		const result = classifyRoomFeed({
			captureMode: "bot",
			platformParticipant: {
				id: "conf-room-2",
				kind: "room",
				isRoomResource: true,
			},
			sourceStream: { id: "room-feed", kind: "participant_audio" },
			diarizedSpeakerCount: 3,
			speakerCountConfidence: 0.91,
		});

		expect(result.state).toBe("multi_speaker_room");
		expect(result.reasonCodes).toContain("participant_declared_room");
		expect(result.reasonCodes).toContain("diarized_multiple_speakers");
		expect(result.uiHints.map((hint) => hint.code)).toEqual([
			"participant_may_represent_room",
			"split_speaker_candidates",
		]);
	});

	it("flags several diarized speakers inside one person participant for split review", () => {
		const result = classifyRoomFeed({
			captureMode: "bot",
			platformParticipant: { id: "tile-1", kind: "person" },
			sourceStream: { id: "tile-1-audio", kind: "participant_audio" },
			diarizedSpeakerCount: 2,
			speakerCountConfidence: 0.9,
			visiblePersonCount: 1,
			faceCountConfidence: 0.9,
			overlapRatio: 0.18,
			nameEvidence: [
				{
					speakerId: "spk-a",
					name: "Mira",
					source: "platform_roster",
					confidence: 0.72,
				},
				{
					speakerId: "spk-b",
					name: "Jon",
					source: "self_introduction",
					confidence: 0.77,
				},
			],
		});

		expect(result.state).toBe("speaker_candidates_split");
		expect(result.requiresReview).toBe(true);
		expect(result.reasonCodes).toContain(
			"candidate_speakers_inside_participant",
		);
		expect(result.candidateSpeakers).toEqual([
			{
				speakerId: "spk-a",
				displayName: "Mira",
				confidence: 0.72,
				provenance: ["platform_roster"],
				bindingAllowed: false,
				requiresReview: true,
			},
			{
				speakerId: "spk-b",
				displayName: "Jon",
				confidence: 0.77,
				provenance: ["self_introduction"],
				bindingAllowed: false,
				requiresReview: true,
			},
		]);
	});

	it("binds a single speaker only with explicit profile or user-correction provenance", () => {
		const result = classifyRoomFeed({
			captureMode: "bot",
			platformParticipant: { id: "p1", kind: "person" },
			diarizedSpeakerCount: 1,
			speakerCountConfidence: 0.96,
			visiblePersonCount: 1,
			faceCountConfidence: 0.9,
			activeSpeakerContinuity: 0.9,
			voiceProfileMatches: [
				{
					speakerId: "speaker-owner",
					profileId: "profile-owner",
					entityId: "entity-owner",
					displayName: "Owner",
					confidence: 0.94,
				},
			],
			nameEvidence: [
				{
					speakerId: "speaker-owner",
					name: "Owner corrected",
					source: "user_correction",
					confidence: 0.96,
				},
			],
		});

		expect(result.state).toBe("profile_bound");
		expect(result.requiresReview).toBe(false);
		expect(result.reasonCodes).toContain("profile_match_with_provenance");
		expect(result.reasonCodes).toContain("user_corrected_identity");
		expect(result.candidateSpeakers).toEqual([
			{
				speakerId: "speaker-owner",
				displayName: "Owner corrected",
				profileId: "profile-owner",
				entityId: "entity-owner",
				confidence: 0.96,
				provenance: ["user_correction", "voice_profile"],
				bindingAllowed: true,
				requiresReview: false,
			},
		]);
	});

	it("requires review on contradictory strong evidence", () => {
		const result = classifyRoomFeed({
			captureMode: "bot",
			platformParticipant: { id: "p1", kind: "person" },
			sourceStream: { id: "s1", kind: "participant_audio" },
			diarizedSpeakerCount: 3,
			speakerCountConfidence: 0.94,
			visiblePersonCount: 1,
			faceCountConfidence: 0.88,
			activeSpeakerContinuity: 0.95,
			overlapRatio: 0.02,
		});

		expect(result.state).toBe("speaker_candidates_split");
		expect(result.reasonCodes).toContain("contradictory_signals");
		expect(result.requiresReview).toBe(true);
	});

	it("withholds names when sensitive guardrails are present", () => {
		const result = classifyRoomFeed({
			diarizedSpeakerCount: 1,
			speakerCountConfidence: 0.92,
			voiceProfileMatches: [
				{
					speakerId: "speaker-1",
					profileId: "profile-1",
					entityId: "entity-1",
					displayName: "Sensitive Name",
					confidence: 0.98,
				},
			],
			sensitiveAttributeGuardrail: true,
		});

		expect(result.state).toBe("unknown");
		expect(result.withholdSpeakerNames).toBe(true);
		expect(result.candidateSpeakers[0]).toEqual({
			speakerId: "speaker-1",
			profileId: "profile-1",
			confidence: 0.98,
			provenance: ["voice_profile"],
			bindingAllowed: true,
			requiresReview: true,
		});
		expect(result.uiHints.map((hint) => hint.code)).toContain(
			"withhold_sensitive_identity",
		);
	});

	it("fails loud on invalid metrics and invalid transitions", () => {
		expect(() =>
			classifyRoomFeed({
				diarizedSpeakerCount: 1.5,
			}),
		).toThrow(/diarizedSpeakerCount/);
		expect(() =>
			classifyRoomFeed({
				speakerCountConfidence: 1.2,
			}),
		).toThrow(/speakerCountConfidence/);

		expect(
			isRoomFeedTransitionAllowed(
				"room_feed_confirmed",
				"individual_feed_likely",
			),
		).toBe(false);
		expect(() =>
			assertRoomFeedTransition("room_feed_confirmed", "individual_feed_likely"),
		).toThrow(/invalid transition/);
	});

	it("declares allowed transitions for every state", () => {
		const states: RoomFeedState[] = [
			"unknown",
			"individual_feed_likely",
			"room_feed_suspected",
			"room_feed_confirmed",
			"multi_speaker_room",
			"speaker_candidates_split",
			"profile_bound",
		];

		for (const state of states) {
			expect(isRoomFeedTransitionAllowed(state, state)).toBe(true);
		}
		expect(
			isRoomFeedTransitionAllowed("room_feed_suspected", "multi_speaker_room"),
		).toBe(true);
		expect(
			isRoomFeedTransitionAllowed("speaker_candidates_split", "profile_bound"),
		).toBe(true);
	});
});
