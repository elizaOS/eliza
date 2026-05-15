/**
 * Tests for the eliza-1 EOT scorer + classifier path. Exercises the
 * scorer in isolation against a deterministic fake `LlamaModel` so the
 * test runs without the native binding.
 */

import { describe, expect, it, vi } from "vitest";
import {
	Eliza1EotClassifier,
	type Eliza1EotScorerOptions,
} from "../eot-classifier";
import {
	Eliza1EotScorer,
	formatEotPrompt,
	type ControlledEvaluateInputLike,
	type ControlledEvaluateOutputLike,
	type LlamaContextLike,
	type LlamaContextSequenceLike,
	type LlamaModelLike,
} from "../eliza1-eot-scorer";

const IM_END_ID = 199;

/**
 * Minimal fake llama model the scorer can drive. The `score()` parameter
 * is the probability we want the fake model to return for `<|im_end|>`
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
	imEndProbability: () => number;
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
									token: IM_END_ID,
									confidence: opts.imEndProbability(),
									probabilities: new Map<number, number>([
										[IM_END_ID, opts.imEndProbability()],
										[42, 1 - opts.imEndProbability()],
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
			if (text === "<|im_end|>") return specialTokens ? [IM_END_ID] : [101, 102];
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
	it("renders a single-user Qwen turn with the im_end stripped", () => {
		const prompt = formatEotPrompt("hello world");
		expect(prompt).toBe("<|im_start|>user\nhello world");
		expect(prompt).not.toContain("<|im_end|>");
	});

	it("trims whitespace so leading/trailing space does not affect scoring", () => {
		expect(formatEotPrompt("  hi  ")).toBe("<|im_start|>user\nhi");
	});
});

describe("Eliza1EotScorer", () => {
	it("returns P(<|im_end|>) reported by the model on the last token", async () => {
		const fake = buildFakeModel({ imEndProbability: () => 0.83 });
		const scorer = new Eliza1EotScorer({ model: fake.model });
		const result = await scorer.score("hello world.");
		expect(result.probability).toBeCloseTo(0.83, 5);
		expect(result.promptTokens).toBeGreaterThan(0);
		// `<|im_end|>` resolution happens once during initialization.
		expect(fake.tokenizeCalls[0]).toBe("<|im_end|>");
	});

	it("falls back to 0.5 when the probabilities map is missing", async () => {
		const fake = {
			model: {
				tokenize(text: string) {
					return text === "<|im_end|>" ? [IM_END_ID] : [1, 2, 3];
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

	it("falls back to 0.5 for empty transcript without calling the model", async () => {
		const fake = buildFakeModel({ imEndProbability: () => 0.9 });
		const scorer = new Eliza1EotScorer({ model: fake.model });
		const result = await scorer.score("   ");
		expect(result.probability).toBe(0.5);
	});

	it("attaches a LoRA adapter to the context when loraPath is set", async () => {
		const fake = buildFakeModel({ imEndProbability: () => 0.5 });
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

	it("truncates the prompt to maxHistoryTokens", async () => {
		const fake = buildFakeModel({ imEndProbability: () => 0.5 });
		const scorer = new Eliza1EotScorer({
			model: fake.model,
			maxHistoryTokens: 5,
		});
		const long = "a".repeat(50);
		const result = await scorer.score(long);
		expect(result.promptTokens).toBe(5);
		expect(fake.controlledEvaluateCalls[0]).toHaveLength(5);
	});

	it("throws a descriptive error when the tokenizer does not resolve im_end to a single id", async () => {
		const fake: LlamaModelLike = {
			tokenize(text: string) {
				// Simulate a non-Qwen model where <|im_end|> tokenizes to plain
				// text (multiple ids).
				if (text === "<|im_end|>") return [10, 11, 12];
				return [1, 2, 3];
			},
			async createContext() {
				throw new Error("createContext should not be called");
			},
		};
		const scorer = new Eliza1EotScorer({ model: fake });
		await expect(scorer.score("x")).rejects.toThrow(/<\|im_end\|>/);
	});

	it("disposes the context on dispose()", async () => {
		const disposeSpy = vi.fn();
		const fake = buildFakeModel({
			imEndProbability: () => 0.5,
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
				if (text === "<|im_end|>") return [IM_END_ID];
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
													[IM_END_ID, 0.6],
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
		const fake = buildFakeModel({ imEndProbability: () => probability });
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
