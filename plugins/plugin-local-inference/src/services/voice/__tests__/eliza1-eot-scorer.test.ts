/**
 * Tests for the eliza-1 EOT scorer + classifier path. Exercises the
 * scorer in isolation against a deterministic fake `LlamaModel` so the
 * test runs without the native binding.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type ControlledEvaluateInputLike,
	type ControlledEvaluateOutputLike,
	Eliza1EotScorer,
	formatEotPrompt,
	type LlamaContextLike,
	type LlamaContextSequenceLike,
	type LlamaModelLike,
} from "../eliza1-eot-scorer";
import {
	Eliza1EotClassifier,
	type Eliza1EotScorerOptions,
} from "../eot-classifier";
import {
	GEMMA4_EOT_TOKEN_CONTRACT,
	LEGACY_GEMMA_EOT_TOKEN_CONTRACT,
} from "../eot-token-contract";

const END_OF_TURN_ID = 199;
const START_OF_TURN_ID = 198;

/**
 * Minimal fake llama model the scorer can drive. The `score()` parameter
 * is the probability we want the fake model to return for `<end_of_turn>`
 * on the next token. Token IDs are derived from char codes so two calls
 * with different prompts produce different token sequences.
 */
interface FakeModelHandle {
	model: LlamaModelLike;
	tokenizeCalls: string[];
	createContextCalls: Array<{ lora?: unknown }>;
	clearHistoryCount: { value: number };
	controlledEvaluateCalls: ControlledEvaluateInputLike[][];
}

function buildFakeModel(opts: {
	endOfTurnProbability: () => number;
	disposeSpy?: () => void;
}): FakeModelHandle {
	const tokenizeCalls: string[] = [];
	const createContextCalls: Array<{ lora?: unknown }> = [];
	const clearHistoryCount = { value: 0 };
	const controlledEvaluateCalls: ControlledEvaluateInputLike[][] = [];

	const sequence: LlamaContextSequenceLike = {
		async clearHistory() {
			clearHistoryCount.value += 1;
		},
		async controlledEvaluate(input) {
			controlledEvaluateCalls.push(input);
			const out: Array<ControlledEvaluateOutputLike | undefined> = input.map(
				(_, i) =>
					i === input.length - 1
						? {
								next: {
									token: END_OF_TURN_ID,
									confidence: opts.endOfTurnProbability(),
									probabilities: new Map<number, number>([
										[END_OF_TURN_ID, opts.endOfTurnProbability()],
										[42, 1 - opts.endOfTurnProbability()],
									]),
								},
							}
						: undefined,
			);
			return out;
		},
	};

	const context: LlamaContextLike = {
		getSequence: () => sequence,
		async dispose() {
			opts.disposeSpy?.();
		},
	};

	const model: LlamaModelLike = {
		tokenize(text: string, specialTokens?: boolean) {
			tokenizeCalls.push(text);
			if (text === "<turn|>")
				return specialTokens ? [END_OF_TURN_ID] : [101, 102];
			if (text === "<|turn>")
				return specialTokens ? [START_OF_TURN_ID] : [103, 104];
			return Array.from(text).map((c) => c.charCodeAt(0));
		},
		async createContext(args) {
			createContextCalls.push({ lora: args?.lora });
			return context;
		},
	};

	return {
		model,
		tokenizeCalls,
		createContextCalls,
		clearHistoryCount,
		controlledEvaluateCalls,
	};
}

describe("formatEotPrompt", () => {
	it("renders a single-user Gemma 4 turn with its closing token omitted", () => {
		const prompt = formatEotPrompt("hello world", GEMMA4_EOT_TOKEN_CONTRACT);
		expect(prompt).toBe("<|turn>user\nhello world");
		expect(prompt).not.toContain("<turn|>");
	});

	it("trims whitespace so leading/trailing space does not affect scoring", () => {
		expect(formatEotPrompt("  hi  ", LEGACY_GEMMA_EOT_TOKEN_CONTRACT)).toBe(
			"<start_of_turn>user\nhi",
		);
	});
});

describe("Eliza1EotScorer", () => {
	it("returns the Gemma 4 turn-terminator probability reported on the last token", async () => {
		const fake = buildFakeModel({ endOfTurnProbability: () => 0.83 });
		const scorer = new Eliza1EotScorer({ model: fake.model });
		const result = await scorer.score("hello world.");
		expect(result.probability).toBeCloseTo(0.83, 5);
		expect(result.promptTokens).toBeGreaterThan(0);
		// The paired Gemma 4 markers are resolved once during initialization.
		expect(fake.tokenizeCalls.slice(0, 2)).toEqual(["<turn|>", "<|turn>"]);
	});

	it("falls back to 0.5 when the probabilities map is missing", async () => {
		const fake = {
			model: {
				tokenize(text: string) {
					if (text === "<turn|>") return [END_OF_TURN_ID];
					if (text === "<|turn>") return [START_OF_TURN_ID];
					return [1, 2, 3];
				},
				async createContext() {
					return {
						getSequence: () => ({
							async clearHistory() {},
							async controlledEvaluate(input: ControlledEvaluateInputLike[]) {
								return input.map((_, i) =>
									i === input.length - 1 ? { next: {} } : undefined,
								);
							},
						}),
						async dispose() {},
					};
				},
			} satisfies LlamaModelLike,
		};
		const scorer = new Eliza1EotScorer({ model: fake.model });
		const result = await scorer.score("anything");
		expect(result.probability).toBe(0.5);
	});

	it("uses the model score for empty transcript input", async () => {
		const fake = buildFakeModel({ endOfTurnProbability: () => 0.9 });
		const scorer = new Eliza1EotScorer({ model: fake.model });
		const result = await scorer.score("   ");
		expect(result.probability).toBe(0.9);
	});

	it("attaches a LoRA adapter to the context when loraPath is set", async () => {
		const fake = buildFakeModel({ endOfTurnProbability: () => 0.5 });
		const scorer = new Eliza1EotScorer({
			model: fake.model,
			loraPath: "/tmp/fake-eot.gguf",
			loraScale: 0.75,
		});
		await scorer.score("hi");
		expect(fake.createContextCalls).toHaveLength(1);
		const lora = fake.createContextCalls[0].lora as {
			adapters: Array<{ filePath: string; scale?: number }>;
		};
		expect(lora.adapters).toEqual([
			{ filePath: "/tmp/fake-eot.gguf", scale: 0.75 },
		]);
		expect(scorer.modelLabel).toContain("eot-lora");
	});

	it("rejects a prompt that cannot fit without discarding input", async () => {
		const fake = buildFakeModel({ endOfTurnProbability: () => 0.5 });
		const scorer = new Eliza1EotScorer({
			model: fake.model,
			contextSize: 5,
		});
		const long = "a".repeat(50);
		await expect(scorer.score(long)).rejects.toThrow(
			/complete prompt requires .* exceeding the dedicated 5-token context/,
		);
		expect(fake.controlledEvaluateCalls).toHaveLength(0);
	});

	it("throws a descriptive error when no paired turn-token contract resolves", async () => {
		const fake: LlamaModelLike = {
			tokenize(text: string) {
				// Simulate a non-Gemma model where both supported marker pairs
				// tokenize as ordinary text.
				if (text.includes("turn")) return [10, 11, 12];
				return [1, 2, 3];
			},
			async createContext() {
				throw new Error("createContext should not be called");
			},
		};
		const scorer = new Eliza1EotScorer({ model: fake });
		await expect(scorer.score("x")).rejects.toThrow(/paired turn-token/);
	});

	it("disposes the context on dispose()", async () => {
		const disposeSpy = vi.fn();
		const fake = buildFakeModel({
			endOfTurnProbability: () => 0.5,
			disposeSpy,
		});
		const scorer = new Eliza1EotScorer({ model: fake.model });
		await scorer.score("anything");
		await scorer.dispose();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent calls so controlledEvaluate is never re-entered", async () => {
		let inflight = 0;
		let maxInflight = 0;
		const fake: LlamaModelLike = {
			tokenize(text: string) {
				if (text === "<turn|>") return [END_OF_TURN_ID];
				if (text === "<|turn>") return [START_OF_TURN_ID];
				return [1, 2, 3];
			},
			async createContext() {
				return {
					getSequence: () => ({
						async clearHistory() {},
						async controlledEvaluate(input: ControlledEvaluateInputLike[]) {
							inflight += 1;
							maxInflight = Math.max(maxInflight, inflight);
							await new Promise((r) => setTimeout(r, 5));
							inflight -= 1;
							return input.map((_, i) =>
								i === input.length - 1
									? {
											next: {
												probabilities: new Map<number, number>([
													[END_OF_TURN_ID, 0.6],
												]),
											},
										}
									: undefined,
							);
						},
					}),
					async dispose() {},
				};
			},
		};
		const scorer = new Eliza1EotScorer({ model: fake });
		await Promise.all([
			scorer.score("a"),
			scorer.score("b"),
			scorer.score("c"),
		]);
		expect(maxInflight).toBe(1);
	});
});

describe("Eliza1EotClassifier", () => {
	function buildOpts(probability: number): Eliza1EotScorerOptions {
		const fake = buildFakeModel({ endOfTurnProbability: () => probability });
		return { model: fake.model };
	}

	it("score() returns just the probability", async () => {
		const classifier = new Eliza1EotClassifier(buildOpts(0.72));
		const p = await classifier.score("how are you?");
		expect(p).toBeCloseTo(0.72, 5);
	});

	it("signal() emits a turn signal sourced as eliza-1-drafter", async () => {
		const classifier = new Eliza1EotClassifier(buildOpts(0.95));
		const signal = await classifier.signal("alright thanks.");
		expect(signal.source).toBe("eliza-1-drafter");
		expect(signal.endOfTurnProbability).toBeCloseTo(0.95, 5);
		expect(signal.nextSpeaker).toBe("agent");
		expect(signal.agentShouldSpeak).toBe(true);
		expect(signal.model).toContain("eliza-1");
		expect(typeof signal.latencyMs).toBe("number");
	});

	it("signal() sets nextSpeaker=user when probability is below mid-clause threshold", async () => {
		const classifier = new Eliza1EotClassifier(buildOpts(0.2));
		const signal = await classifier.signal("and then i was");
		expect(signal.nextSpeaker).toBe("user");
		expect(signal.agentShouldSpeak).toBe(false);
	});
});
