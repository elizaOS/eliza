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

	it("flattenTrajectoryMessages returns empty for absent or empty message arrays", () => {
		expect(flattenTrajectoryMessages(undefined)).toBe("");
		expect(flattenTrajectoryMessages([])).toBe("");
	});

	it("flattenTrajectoryMessages joins messages with a blank line and stringifies primitives", () => {
		expect(
			flattenTrajectoryMessages([
				{ role: "assistant", content: "first" },
				42,
				null,
				{ role: "user", content: "last" },
			]),
		).toBe("assistant:\nfirst\n\n42\n\nnull\n\nuser:\nlast");
	});

	it("flattenTrajectoryMessages falls back for missing roles and serializes non-string content", () => {
		expect(flattenTrajectoryMessages([{ content: "no role here" }])).toBe(
			"message:\nno role here",
		);
		// An absent content serializes as "null" so the trajectory shows the hole.
		expect(flattenTrajectoryMessages([{ role: "user" }])).toBe("user:\nnull");
		expect(
			flattenTrajectoryMessages([
				{ role: "user", content: { intent: "book" } },
			]),
		).toBe('user:\n{"intent":"book"}');
	});

	it("canonicalPromptForModelCall prefers flattened messages and falls back to the bare prompt", () => {
		const messages = [{ role: "user", content: "from messages" }];
		expect(canonicalPromptForModelCall({ messages })).toBe(
			"user:\nfrom messages",
		);
		expect(
			canonicalPromptForModelCall({ messages: [], prompt: "bare prompt" }),
		).toBe("bare prompt");
		expect(canonicalPromptForModelCall({ messages: [], prompt: null })).toBe(
			"",
		);
		expect(canonicalPromptForModelCall({})).toBe("");
	});

	it("omitUnvalidatedProviderSpans preserves the undefined and empty input shapes", () => {
		expect(omitUnvalidatedProviderSpans(undefined)).toBeUndefined();
		expect(omitUnvalidatedProviderSpans([])).toEqual([]);
	});

	it("estimateTrajectoryTextTokens rounds character length up at 3.5 chars per token", () => {
		expect(estimateTrajectoryTextTokens("")).toBe(0);
		expect(estimateTrajectoryTextTokens("abc")).toBe(1);
		expect(estimateTrajectoryTextTokens("abcdefg")).toBe(2);
	});

	it("sha256Text hashes deterministically and distinguishes inputs", () => {
		expect(sha256Text("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Text("hello")).toBe(sha256Text("hello"));
		expect(sha256Text("hello")).not.toBe(sha256Text("hellp"));
	});

	it("buildProviderAttributionsFromState returns empty results without provider data", () => {
		expect(buildProviderAttributionsFromState({ prompt: "anything" })).toEqual({
			providerOrder: [],
			providerAttributions: [],
		});
		expect(
			buildProviderAttributionsFromState({
				state: { data: {} } as State,
				prompt: "anything",
			}),
		).toEqual({ providerOrder: [], providerAttributions: [] });
	});

	it("derives a sorted providerOrder from the provider map when none is recorded", () => {
		const state = {
			data: {
				providers: {
					ZULU: { providerName: "ZULU", text: "zulu text" },
					ALPHA: { providerName: "ALPHA", text: "alpha text" },
				},
			},
		} as State;
		const result = buildProviderAttributionsFromState({ state });
		expect(result.providerOrder).toEqual(["ALPHA", "ZULU"]);
		expect(result.providerAttributions.map((entry) => entry.providerName)) //
			.toEqual(["ALPHA", "ZULU"]);
		expect(result.providerAttributions.map((entry) => entry.position)) //
			.toEqual([0, 1]);
		// No prompt captured → identity survives, spans stay omitted.
		for (const entry of result.providerAttributions) {
			expect(entry.spanStart).toBeUndefined();
			expect(entry.spanEnd).toBeUndefined();
			expect(entry.tokenCountEstimated).toBe(true);
		}
	});

	it("skips duplicate, missing-from-map, and whitespace-only provider entries while trimming kept text", () => {
		const state = {
			data: {
				providerOrder: ["ECHO", "ECHO", "ABSENT", "BLANK", "PADDED"],
				providers: {
					ECHO: { providerName: "ECHO", text: "echo text" },
					BLANK: { providerName: "BLANK", text: "   " },
					PADDED: { providerName: "PADDED", text: "  padded text  " },
				},
			},
		} as State;
		const result = buildProviderAttributionsFromState({
			state,
			prompt: "echo text padded text",
		});
		// The recorded order is echoed verbatim, duplicates included.
		expect(result.providerOrder).toEqual([
			"ECHO",
			"ECHO",
			"ABSENT",
			"BLANK",
			"PADDED",
		]);
		const [echo, padded] = result.providerAttributions;
		expect(echo.position).toBe(0);
		expect(padded.position).toBe(1);
		expect(padded.providerName).toBe("PADDED");
		// Kept snapshots trim their text: hash, tokens, and span all use it.
		expect(padded.sha256).toBe(sha256Text("padded text"));
		expect(padded.tokenCount).toBe(estimateTrajectoryTextTokens("padded text"));
		expect(padded.spanStart).toBe(
			"echo text padded text".indexOf("padded text"),
		);
	});

	it("advances the span cursor so identical provider texts claim successive occurrences", () => {
		const state = {
			data: {
				providerOrder: ["FIRST", "SECOND"],
				providers: {
					FIRST: { providerName: "FIRST", text: "same words" },
					SECOND: { providerName: "SECOND", text: "same words" },
				},
			},
		} as State;
		const doubled = "same words same words";
		const [first, second] = buildProviderAttributionsFromState({
			state,
			prompt: doubled,
		}).providerAttributions;
		expect(first.spanStart).toBe(0);
		expect(second.spanStart).toBe(doubled.indexOf("same words", first.spanEnd));
		expect(doubled.slice(second.spanStart, second.spanEnd)).toBe("same words");

		// A single occurrence cannot be claimed twice: the later provider omits
		// its span while keeping hash, estimate label, order, and position.
		const singlePrompt = "only one set of same words here";
		const single = buildProviderAttributionsFromState({
			state,
			prompt: singlePrompt,
		});
		expect(single.providerAttributions[0].spanStart).toBe(
			singlePrompt.indexOf("same words"),
		);
		expect(single.providerAttributions[1]).toEqual({
			providerName: "SECOND",
			sha256: sha256Text("same words"),
			tokenCount: 3,
			tokenCountEstimated: true,
			position: 1,
		});
	});

	it("estimatedProviderInputCostShareUsd refuses non-positive, non-finite, or clamped-to-zero inputs", () => {
		for (const cost of [
			undefined,
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(
				estimatedProviderInputCostShareUsd({
					costUsd: cost,
					promptTokens: 100,
					completionTokens: 100,
					providerTokenEstimate: 50,
					totalProviderTokenEstimates: 50,
				}),
			).toBe(0);
		}
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: 100,
				completionTokens: 100,
				providerTokenEstimate: -5,
				totalProviderTokenEstimates: 50,
			}),
		).toBe(0);
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: 100,
				completionTokens: 100,
				providerTokenEstimate: 0,
				totalProviderTokenEstimates: 50,
			}),
		).toBe(0);
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: 100,
				completionTokens: 100,
				providerTokenEstimate: 50,
				totalProviderTokenEstimates: Number.NaN,
			}),
		).toBe(0);
	});

	it("estimatedProviderInputCostShareUsd treats absent completion tokens as fully input spend", () => {
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 2,
				promptTokens: 10,
				completionTokens: undefined,
				providerTokenEstimate: 4,
				totalProviderTokenEstimates: 4,
			}),
		).toBeCloseTo(0.8, 10);
		// The denominator grows to the larger of prompt tokens and summed estimates.
		expect(
			estimatedProviderInputCostShareUsd({
				costUsd: 1,
				promptTokens: 100,
				completionTokens: 0,
				providerTokenEstimate: 20,
				totalProviderTokenEstimates: 40,
			}),
		).toBeCloseTo(0.2, 10);
	});
});
