/**
 * Unit coverage for trajectory provider attribution: hash-first provider
 * records, ordered prompt spans, compose→model rebinding, and estimate labels.
 */
import { describe, expect, it } from "vitest";
import type { State } from "../../types/state";
import {
	buildProviderAttributionsFromState,
	canonicalPromptForModelCall,
	estimatedProviderInputCostShareUsd,
	estimateTrajectoryTextTokens,
	flattenTrajectoryMessages,
	omitUnvalidatedProviderSpans,
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
			expect(entry.tokenCountEstimated).toBe(true);
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
				tokenCountEstimated: true,
				position: 0,
			},
		]);
	});

	it("rebinding compose providersText spans onto the larger model messages prompt", () => {
		// Regression for #14877: composeState locates spans against the joined
		// providers block alone; useModel must re-locate against the full
		// recorded messages prompt or omit spans.
		const characterText = "Character voice: precise and brief.";
		const recentText = "User: remind me tomorrow.";
		const state = {
			data: {
				providerOrder: ["CHARACTER", "RECENT_MESSAGES"],
				providers: {
					CHARACTER: { providerName: "CHARACTER", text: characterText },
					RECENT_MESSAGES: {
						providerName: "RECENT_MESSAGES",
						text: recentText,
					},
				},
			},
		} as State;
		const providersText = `${characterText}\n${recentText}`;
		const composeLocal = buildProviderAttributionsFromState({
			state,
			prompt: providersText,
		});
		// Compose-local spans index into providersText, not the model prompt.
		expect(
			providersText.slice(
				composeLocal.providerAttributions[0].spanStart,
				composeLocal.providerAttributions[0].spanEnd,
			),
		).toBe(characterText);

		const messages = [
			{ role: "system", content: "You are Eliza." },
			{
				role: "user",
				content: `Context:\n${characterText}\n\nRecent:\n${recentText}`,
			},
		];
		const modelPrompt = canonicalPromptForModelCall({ messages });
		// Copying compose spans onto the model prompt would slice the wrong text.
		const falseSlice = modelPrompt.slice(
			composeLocal.providerAttributions[0].spanStart,
			composeLocal.providerAttributions[0].spanEnd,
		);
		expect(falseSlice).not.toBe(characterText);

		const rebound = buildProviderAttributionsFromState({
			state,
			prompt: modelPrompt,
		});
		const [character, recent] = rebound.providerAttributions;
		expect(modelPrompt.slice(character.spanStart, character.spanEnd)).toBe(
			characterText,
		);
		expect(modelPrompt.slice(recent.spanStart, recent.spanEnd)).toBe(
			recentText,
		);
		expect(character.tokenCountEstimated).toBe(true);
		expect(character.tokenCount).toBe(
			estimateTrajectoryTextTokens(characterText),
		);
	});

	it("omitUnvalidatedProviderSpans drops offsets while keeping estimate labels", () => {
		const stripped = omitUnvalidatedProviderSpans([
			{
				providerName: "CHARACTER",
				sha256: sha256Text("x"),
				tokenCount: 1,
				position: 0,
				spanStart: 0,
				spanEnd: 1,
			},
		]);
		expect(stripped).toEqual([
			{
				providerName: "CHARACTER",
				sha256: sha256Text("x"),
				tokenCount: 1,
				tokenCountEstimated: true,
				position: 0,
			},
		]);
	});

	it("estimatedProviderInputCostShareUsd allocates only the prompt-token share", () => {
		// $1 call, half prompt tokens, provider text covers 10/50 prompt tokens → $0.10.
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: 50,
				completionTokens: 50,
				providerTokenEstimate: 10,
				totalProviderTokenEstimates: 10,
			}),
		).toBeCloseTo(0.1, 8);
		// Over-estimation is capped at the full input share rather than overclaiming it.
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: 50,
				completionTokens: 50,
				providerTokenEstimate: 50,
				totalProviderTokenEstimates: 100,
			}),
		).toBeCloseTo(0.25, 8);
		// No prompt tokens observed → refuse to allocate (do not dump full cost).
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: undefined,
				completionTokens: 50,
				providerTokenEstimate: 10,
				totalProviderTokenEstimates: 10,
			}),
		).toBe(0);
	});
});
