/**
 * Covers the message service's voice-turn helpers: dual-path parsing of the
 * turn-signal and speaker id from either content top-level or content.metadata,
 * and the server-side suppress/confirm truth table over the client's signal (#9147).
 */
import { describe, expect, it } from "vitest";
import {
	getVoiceSpeakerEntityId,
	getVoiceTurnSignalMetadata,
	voiceTurnSignalConfirmsAgent,
	voiceTurnSignalSuppressesAgent,
} from "./message";

/** Build a message with the given content (cast past the typed Content). */
function msg(content: Record<string, unknown>) {
	return { content } as unknown as Parameters<
		typeof getVoiceTurnSignalMetadata
	>[0];
}

// #9147 — the ambient signal/speaker is read from EITHER content top-level
// (in-process voice path) OR content.metadata (chat clients). Lock both paths.
describe("getVoiceTurnSignalMetadata — dual-path parsing (#9147)", () => {
	it("reads a top-level voiceTurnSignal (in-process path)", () => {
		expect(
			getVoiceTurnSignalMetadata(
				msg({ voiceTurnSignal: { nextSpeaker: "user" } }),
			),
		).toEqual({ nextSpeaker: "user" });
	});

	it("reads a nested content.metadata.voiceTurnSignal (chat-client path)", () => {
		expect(
			getVoiceTurnSignalMetadata(
				msg({ metadata: { voiceTurnSignal: { agentShouldSpeak: false } } }),
			),
		).toEqual({ agentShouldSpeak: false });
	});

	it("returns null when absent or non-object", () => {
		expect(getVoiceTurnSignalMetadata(msg({}))).toBeNull();
		expect(
			getVoiceTurnSignalMetadata(msg({ voiceTurnSignal: "nope" })),
		).toBeNull();
	});

	it("drops invalid fields and returns null when nothing valid remains", () => {
		expect(
			getVoiceTurnSignalMetadata(
				msg({ voiceTurnSignal: { nextSpeaker: "sideways" } }),
			),
		).toBeNull();
	});

	it("preserves an explicit agentShouldSpeak: null (unknown)", () => {
		expect(
			getVoiceTurnSignalMetadata(
				msg({ voiceTurnSignal: { agentShouldSpeak: null } }),
			),
		).toEqual({ agentShouldSpeak: null });
	});
});

describe("getVoiceSpeakerEntityId — dual-path parsing (#9147)", () => {
	it("reads + trims a top-level speakerEntityId", () => {
		expect(getVoiceSpeakerEntityId(msg({ speakerEntityId: "  ent-1  " }))).toBe(
			"ent-1",
		);
	});

	it("reads a nested content.metadata.speakerEntityId", () => {
		expect(
			getVoiceSpeakerEntityId(msg({ metadata: { speakerEntityId: "ent-2" } })),
		).toBe("ent-2");
	});

	it("returns null when absent or blank", () => {
		expect(getVoiceSpeakerEntityId(msg({}))).toBeNull();
		expect(getVoiceSpeakerEntityId(msg({ speakerEntityId: "   " }))).toBeNull();
	});
});

// #9147 — the server-side voice-turn-signal gate (decide/veto over the client's
// VoiceTurnSignalMetadata). These were untested; lock the truth table so the
// suppress/confirm contract can't drift.
describe("server voice-turn-signal gate (#9147)", () => {
	describe("voiceTurnSignalSuppressesAgent", () => {
		it("fails open on a null signal (no signal never silences a turn)", () => {
			expect(voiceTurnSignalSuppressesAgent(null)).toBe(false);
		});
		it("suppresses when the client says the agent should not speak", () => {
			expect(voiceTurnSignalSuppressesAgent({ agentShouldSpeak: false })).toBe(
				true,
			);
		});
		it("suppresses when the next speaker is the user", () => {
			expect(voiceTurnSignalSuppressesAgent({ nextSpeaker: "user" })).toBe(
				true,
			);
		});
		it("suppresses when end-of-turn reads as the user still talking (<0.4)", () => {
			expect(
				voiceTurnSignalSuppressesAgent({ endOfTurnProbability: 0.3 }),
			).toBe(true);
		});
		it("does not suppress a clean agent turn", () => {
			expect(
				voiceTurnSignalSuppressesAgent({
					agentShouldSpeak: true,
					nextSpeaker: "agent",
					endOfTurnProbability: 0.9,
				}),
			).toBe(false);
		});
	});

	describe("voiceTurnSignalConfirmsAgent", () => {
		it("does not confirm a null signal", () => {
			expect(voiceTurnSignalConfirmsAgent(null)).toBe(false);
		});
		it("confirms on an explicit agentShouldSpeak with a non-user next speaker", () => {
			expect(
				voiceTurnSignalConfirmsAgent({
					agentShouldSpeak: true,
					nextSpeaker: "agent",
				}),
			).toBe(true);
		});
		it("does not confirm when end-of-turn reads as still talking (<0.4)", () => {
			expect(
				voiceTurnSignalConfirmsAgent({
					agentShouldSpeak: true,
					endOfTurnProbability: 0.3,
				}),
			).toBe(false);
		});
		it("does not confirm when the next speaker is the user", () => {
			expect(
				voiceTurnSignalConfirmsAgent({
					agentShouldSpeak: true,
					nextSpeaker: "user",
				}),
			).toBe(false);
		});
		it("is conservative: a merely-absent agentShouldSpeak never confirms", () => {
			expect(voiceTurnSignalConfirmsAgent({ nextSpeaker: "agent" })).toBe(
				false,
			);
		});
	});
});
