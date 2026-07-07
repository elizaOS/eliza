/**
 * Unit coverage for trajectory provider attribution: hash-first provider
 * records, ordered prompt spans, and exact prompt-slice round trips.
 */
import { describe, expect, it } from "bun:test";
import type { State } from "../../types/state";
import {
	buildProviderAttributionsFromState,
	flattenTrajectoryMessages,
	sha256Text,
} from "../trajectory-provider-attribution";

describe("trajectory provider attribution", () => {
	it("records provider order and spans that round-trip against the prompt", () => {
		const state = {
			data: {
				providerOrder: ["CHARACTER", "RECENT_MESSAGES"],
				providers: {
					CHARACTER: {
						providerName: "CHARACTER",
						text: "Character voice: precise and brief.",
					},
					RECENT_MESSAGES: {
						providerName: "RECENT_MESSAGES",
						text: "User: remind me tomorrow.",
					},
				},
			},
		} as State;
		// The recorded stage persists `messages`, never a second flattened prompt.
		// Spans index into the read-time reconstruction of that same array, so the
		// round trip below mirrors exactly what a consumer reconstructs on read.
		const messages = [
			{
				role: "system",
				content: "provider:CHARACTER:\nCharacter voice: precise and brief.",
			},
			{
				role: "user",
				content: "provider:RECENT_MESSAGES:\nUser: remind me tomorrow.",
			},
		];
		const prompt = flattenTrajectoryMessages(messages);

		const result = buildProviderAttributionsFromState({ state, prompt });

		expect(result.providerOrder).toEqual(["CHARACTER", "RECENT_MESSAGES"]);
		expect(result.providerAttributions).toHaveLength(2);
		for (const entry of result.providerAttributions) {
			expect(entry.sha256).toHaveLength(64);
			expect(entry.tokenCount).toBeGreaterThan(0);
			expect(entry.spanStart).toBeGreaterThanOrEqual(0);
			expect(entry.spanEnd).toBeGreaterThan(entry.spanStart ?? 0);
		}
		const [character, recent] = result.providerAttributions;
		// Reconstruct from `messages` (as a reader does) — no stored prompt needed.
		const reconstructed = flattenTrajectoryMessages(messages);
		expect(reconstructed.slice(character.spanStart, character.spanEnd)).toBe(
			"Character voice: precise and brief.",
		);
		expect(reconstructed.slice(recent.spanStart, recent.spanEnd)).toBe(
			"User: remind me tomorrow.",
		);
		expect(character.sha256).toBe(
			sha256Text("Character voice: precise and brief."),
		);
	});

	it("omits spans when a provider was selected but not rendered into the prompt", () => {
		const state = {
			data: {
				providerOrder: ["ACTIONS"],
				providers: {
					ACTIONS: { providerName: "ACTIONS", text: "tool catalog" },
				},
			},
		} as State;

		const result = buildProviderAttributionsFromState({
			state,
			prompt: "planner_stage:\nNo provider block here.",
		});

		expect(result.providerAttributions).toEqual([
			{
				providerName: "ACTIONS",
				sha256: sha256Text("tool catalog"),
				tokenCount: 4,
				position: 0,
			},
		]);
	});
});
