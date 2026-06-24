// Coverage for the pure VoiceScenario validator + turn helpers (#9147). The
// validator gates every test-matrix scenario before the corpus build, so its
// id/participant/turn/agent/environment checks are worth pinning directly.

import { describe, expect, it } from "vitest";
import {
	resolveTurnEnvironment,
	turnReferenceTranscript,
	turnSpeakerLabel,
	type VoiceEnvironment,
	type VoiceScenario,
	validateVoiceScenario,
} from "./voice-scenario";

function validScenario(): VoiceScenario {
	return {
		id: "s1",
		classes: ["diarization"],
		participants: [{ label: "alice" }, { label: "bob" }],
		turns: [
			{ speaker: "alice", text: "hello", expectRespond: true },
			{ speaker: "bob", text: "hi there", expectRespond: false },
		],
	};
}

describe("validateVoiceScenario", () => {
	it("accepts a well-formed scenario", () => {
		expect(validateVoiceScenario(validScenario())).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("requires id, a non-empty classes array, participants, and turns", () => {
		const r = validateVoiceScenario({
			id: "  ",
			classes: [],
			participants: [],
			turns: [],
		});
		expect(r.valid).toBe(false);
		expect(r.errors).toContain("scenario.id is required");
		expect(r.errors).toContain("scenario.classes must be a non-empty array");
		expect(r.errors).toContain("scenario.participants must be non-empty");
		expect(r.errors).toContain("scenario.turns must be a non-empty array");
	});

	it("flags duplicate participant labels", () => {
		const s = validScenario();
		s.participants = [{ label: "alice" }, { label: "alice" }];
		expect(validateVoiceScenario(s).errors).toContain(
			"duplicate participant label: alice",
		);
	});

	it("flags a turn whose speaker is not a participant", () => {
		const s = validScenario();
		s.turns = [{ speaker: "carol", text: "hi", expectRespond: true }];
		expect(validateVoiceScenario(s).errors).toContain(
			'turn[0].speaker "carol" is not a participant',
		);
	});

	it("requires each turn to carry text or audioRef and a boolean expectRespond", () => {
		const s = validScenario();
		// @ts-expect-error — exercising the runtime guard for a missing expectRespond
		s.turns = [{ speaker: "alice" }];
		const errors = validateVoiceScenario(s).errors;
		expect(errors).toContain("turn[0] must have either text or audioRef");
		expect(errors).toContain("turn[0].expectRespond must be a boolean");
	});

	it("flags an agent label that is not a participant", () => {
		const s = validScenario();
		s.agents = ["ghost"];
		expect(validateVoiceScenario(s).errors).toContain(
			'agent "ghost" is not a participant',
		);
	});

	it("validates acoustic environment ranges (reverb in [0,1], far-field >= 0)", () => {
		const s = validScenario();
		s.environment = { reverb: 2, farFieldDb: -3 } as VoiceEnvironment;
		const errors = validateVoiceScenario(s).errors;
		expect(errors).toContain("scenario.environment.reverb must be in [0, 1]");
		expect(errors).toContain(
			"scenario.environment.farFieldDb must be a non-negative dB attenuation",
		);
	});

	it("collects every error at once instead of throwing on the first", () => {
		const r = validateVoiceScenario({
			id: "",
			classes: [],
			participants: [{ label: "alice" }],
			turns: [{ speaker: "nope", text: "x", expectRespond: true }],
		});
		expect(r.valid).toBe(false);
		expect(r.errors.length).toBeGreaterThanOrEqual(3);
	});
});

describe("turn helpers", () => {
	it("resolveTurnEnvironment merges turn over scenario (turn wins)", () => {
		const s = validScenario();
		s.environment = { reverb: 0.2, noiseSnrDb: 10 } as VoiceEnvironment;
		const turn = {
			speaker: "alice",
			text: "hi",
			expectRespond: true,
			environment: { reverb: 0.8 } as VoiceEnvironment,
		};
		expect(resolveTurnEnvironment(s, turn)).toEqual({
			reverb: 0.8,
			noiseSnrDb: 10,
		});
		// Both absent → undefined.
		expect(
			resolveTurnEnvironment(validScenario(), {
				speaker: "alice",
				text: "hi",
				expectRespond: true,
			}),
		).toBeUndefined();
	});

	it("turnReferenceTranscript prefers the explicit override, else the text", () => {
		expect(
			turnReferenceTranscript({
				speaker: "a",
				text: "spoken",
				expectedTranscript: "  override  ",
				expectRespond: true,
			}),
		).toBe("override");
		expect(
			turnReferenceTranscript({
				speaker: "a",
				text: "  just text  ",
				expectRespond: true,
			}),
		).toBe("just text");
	});

	it("turnSpeakerLabel prefers the explicit diarization label, else the speaker", () => {
		expect(
			turnSpeakerLabel({
				speaker: "alice",
				text: "x",
				expectedSpeakerLabel: "SPEAKER_01",
				expectRespond: true,
			}),
		).toBe("SPEAKER_01");
		expect(
			turnSpeakerLabel({ speaker: "alice", text: "x", expectRespond: true }),
		).toBe("alice");
	});
});
