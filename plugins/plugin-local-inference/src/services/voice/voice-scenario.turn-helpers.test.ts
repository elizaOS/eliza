/**
 * Unit coverage for the voice-scenario per-turn resolvers (#9147 voice).
 *
 * resolveTurnEnvironment / turnReferenceTranscript / turnSpeakerLabel are the
 * pure helpers that resolve a scenario turn's augmentation environment, its
 * reference transcript, and its expected speaker label — the inputs the
 * multi-speaker / noise-music / self-rejection scenario harness scores against.
 * They were untested. No GGUF / audio.
 */

import { describe, expect, it } from "vitest";
import {
	resolveTurnEnvironment,
	turnReferenceTranscript,
	turnSpeakerLabel,
	type VoiceScenario,
	type VoiceScenarioTurn,
} from "./voice-scenario";

const turn = (over: Partial<VoiceScenarioTurn>): VoiceScenarioTurn =>
	({ speaker: "alice", text: "hi", ...over }) as VoiceScenarioTurn;
const scenario = (over: Partial<VoiceScenario>): VoiceScenario =>
	({ ...over }) as VoiceScenario;

describe("resolveTurnEnvironment", () => {
	it("returns undefined when neither scenario nor turn set an environment", () => {
		expect(resolveTurnEnvironment(scenario({}), turn({}))).toBeUndefined();
	});

	it("merges scenario + turn environment with the turn winning", () => {
		const merged = resolveTurnEnvironment(
			scenario({ environment: { noiseSnrDb: 20, reverb: 0.3 } }),
			turn({ environment: { noiseSnrDb: 5 } }),
		);
		expect(merged).toEqual({ noiseSnrDb: 5, reverb: 0.3 });
	});

	it("uses the scenario environment alone when the turn has none", () => {
		expect(
			resolveTurnEnvironment(
				scenario({ environment: { noiseSnrDb: 12 } }),
				turn({}),
			),
		).toEqual({ noiseSnrDb: 12 });
	});
});

describe("turnReferenceTranscript", () => {
	it("prefers expectedTranscript, then text, then empty — trimmed", () => {
		expect(
			turnReferenceTranscript(turn({ expectedTranscript: "  hello  " })),
		).toBe("hello");
		expect(
			turnReferenceTranscript(
				turn({ expectedTranscript: undefined, text: "  hey " }),
			),
		).toBe("hey");
		expect(
			turnReferenceTranscript(
				turn({ expectedTranscript: undefined, text: undefined }),
			),
		).toBe("");
	});
});

describe("turnSpeakerLabel", () => {
	it("prefers expectedSpeakerLabel, falls back to speaker", () => {
		expect(
			turnSpeakerLabel(turn({ speaker: "bob", expectedSpeakerLabel: "Bob" })),
		).toBe("Bob");
		expect(
			turnSpeakerLabel(
				turn({ speaker: "carol", expectedSpeakerLabel: undefined }),
			),
		).toBe("carol");
	});
});
