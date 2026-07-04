/** Covers the FFI streaming runner's per-step token loop and `maxTokensPerStep` resolution against a fake streaming binding. Deterministic, no native lib. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FfiStreamingRunner,
	resolveMaxTokensPerStep,
} from "./ffi-streaming-runner";
import type {
	LlmCtxHandle,
	LlmStreamingBinding,
} from "./llm-streaming-binding";
import type { LlmStreamHandle, LlmStreamStep } from "./voice/ffi-bindings";

/**
 * Build a binding whose `llmStreamNext` emits `steps.length` steps (the last
 * with `done: true`), and that records the `maxTokensPerStep` passed on every
 * call so tests can assert the resolved per-step cap.
 */
function makeStepBinding(steps: string[]): {
	binding: LlmStreamingBinding;
	stepCaps: number[];
} {
	const stream = 7n as LlmStreamHandle;
	const stepCaps: number[] = [];
	let i = 0;
	const llmStreamNext = vi.fn(
		(args: { maxTokensPerStep?: number }): LlmStreamStep => {
			stepCaps.push(args.maxTokensPerStep ?? -1);
			const text = steps[i] ?? "";
			const done = i >= steps.length - 1;
			i += 1;
			return {
				tokens: [i],
				text,
				done,
				drafterDrafted: 0,
				drafterAccepted: 0,
			};
		},
	);
	const binding: LlmStreamingBinding = {
		llmStreamSupported: () => true,
		llmStreamOpen: vi.fn().mockReturnValue(stream),
		llmStreamPrefill: vi.fn(),
		llmStreamNext,
		llmStreamCancel: vi.fn(),
		llmStreamClose: vi.fn(),
	};
	return { binding, stepCaps };
}

const BASE_ARGS = {
	slotId: 0,
	maxTokens: 64,
	temperature: 0,
	topP: 1,
	topK: 0,
	repeatPenalty: 1,
	draftMin: 0,
	draftMax: 0,
	draftModelPath: null,
} as const;

describe("FfiStreamingRunner prewarm", () => {
	it("treats maxTokens: 0 as prefill-only and never calls next-token generation", async () => {
		const stream = 7n as LlmStreamHandle;
		const binding: LlmStreamingBinding = {
			llmStreamSupported: () => true,
			llmStreamOpen: vi.fn().mockReturnValue(stream),
			llmStreamPrefill: vi.fn(),
			llmStreamNext: vi.fn().mockReturnValue({
				tokens: [1],
				text: "x",
				done: true,
				drafterDrafted: 0,
				drafterAccepted: 0,
			}),
			llmStreamCancel: vi.fn(),
			llmStreamClose: vi.fn(),
		};
		const onTextChunk = vi.fn();
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);
		const promptTokens = new Int32Array([11, 12, 13]);

		const result = await runner.generateWithUsage({
			promptTokens,
			slotId: 0,
			maxTokens: 0,
			temperature: 0,
			topP: 1,
			topK: 0,
			repeatPenalty: 1,
			draftMin: 0,
			draftMax: 0,
			draftModelPath: null,
			contextSize: 32_768,
			onTextChunk,
		});

		expect(binding.llmStreamOpen).toHaveBeenCalledTimes(1);
		expect(binding.llmStreamOpen).toHaveBeenCalledWith({
			ctx: 1n,
			config: expect.objectContaining({
				contextSize: 32_768,
			}),
		});
		expect(binding.llmStreamPrefill).toHaveBeenCalledWith({
			stream,
			tokens: promptTokens,
		});
		expect(binding.llmStreamNext).not.toHaveBeenCalled();
		expect(onTextChunk).not.toHaveBeenCalled();
		expect(binding.llmStreamClose).toHaveBeenCalledWith(stream);
		expect(result).toEqual({
			text: "",
			slotId: 0,
			firstTokenMs: null,
			drafted: 0,
			accepted: 0,
		});
	});
});

describe("FfiStreamingRunner per-step granularity (#9174)", () => {
	const ORIGINAL = process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
	afterEach(() => {
		if (ORIGINAL === undefined) {
			delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
		} else {
			process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = ORIGINAL;
		}
	});

	it("defaults to a 32-token per-step cap when no override is set", async () => {
		delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
		const { binding, stepCaps } = makeStepBinding(["Hi ", "there"]);
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);
		await runner.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
		});
		expect(stepCaps).toEqual([32, 32]);
	});

	it("forwards a per-call maxTokensPerStep to every llmStreamNext call", async () => {
		delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
		const { binding, stepCaps } = makeStepBinding(["a", "b", "c"]);
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);
		await runner.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
			maxTokensPerStep: 4,
		});
		expect(stepCaps).toEqual([4, 4, 4]);
	});

	it("honors the ELIZA_LOCAL_STREAM_TOKENS_PER_STEP env override", async () => {
		process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "8";
		const { binding, stepCaps } = makeStepBinding(["x", "y"]);
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);
		await runner.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
		});
		expect(stepCaps).toEqual([8, 8]);
	});

	it("lets a per-call override win over the env var", async () => {
		process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "8";
		const { binding, stepCaps } = makeStepBinding(["x"]);
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);
		await runner.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
			maxTokensPerStep: 1,
		});
		expect(stepCaps).toEqual([1]);
	});

	it("clamps out-of-range per-call overrides into the supported window", async () => {
		delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
		const low = makeStepBinding(["x"]);
		const runnerLow = new FfiStreamingRunner(low.binding, 1n as LlmCtxHandle);
		await runnerLow.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
			maxTokensPerStep: 0,
		});
		// 0 floors to the minimum of 1, never disables generation.
		expect(low.stepCaps).toEqual([1]);

		const high = makeStepBinding(["x"]);
		const runnerHigh = new FfiStreamingRunner(high.binding, 1n as LlmCtxHandle);
		await runnerHigh.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
			maxTokensPerStep: 100_000,
		});
		expect(high.stepCaps).toEqual([512]);
	});

	describe("resolveMaxTokensPerStep", () => {
		it("returns 32 when unset", () => {
			delete process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP;
			expect(resolveMaxTokensPerStep()).toBe(32);
		});

		it("parses and clamps a valid env value", () => {
			process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "16";
			expect(resolveMaxTokensPerStep()).toBe(16);
			process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "9999";
			expect(resolveMaxTokensPerStep()).toBe(512);
			process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "0";
			expect(resolveMaxTokensPerStep()).toBe(1);
		});

		it("falls back to 32 on a non-numeric env value", () => {
			process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP = "smooth";
			expect(resolveMaxTokensPerStep()).toBe(32);
		});
	});
});

describe("FfiStreamingRunner generateStream slot single-flight", () => {
	/** Binding with per-stream step state + an open/close event log. */
	function makeSerializingProbeBinding(): {
		binding: LlmStreamingBinding;
		events: string[];
	} {
		const events: string[] = [];
		let streamCounter = 0n;
		const stepByStream = new Map<bigint, number>();
		const binding: LlmStreamingBinding = {
			llmStreamSupported: () => true,
			llmStreamOpen: vi.fn((): LlmStreamHandle => {
				streamCounter += 1n;
				stepByStream.set(streamCounter, 0);
				events.push("open");
				return streamCounter as LlmStreamHandle;
			}),
			llmStreamPrefill: vi.fn(),
			llmStreamNext: vi.fn(
				(args: { stream: LlmStreamHandle }): LlmStreamStep => {
					const i = stepByStream.get(args.stream as bigint) ?? 0;
					stepByStream.set(args.stream as bigint, i + 1);
					return {
						tokens: [i],
						text: i === 0 ? "a" : "b",
						done: i >= 1,
						drafterDrafted: 0,
						drafterAccepted: 0,
					};
				},
			),
			llmStreamCancel: vi.fn(),
			llmStreamClose: vi.fn(() => {
				events.push("close");
			}),
		};
		return { binding, events };
	}

	it("serializes generateStream against generateWithUsage on the same pinned slot", async () => {
		const { binding, events } = makeSerializingProbeBinding();
		const runner = new FfiStreamingRunner(binding, 1n as LlmCtxHandle);

		let releaseFirstChunk!: () => void;
		const firstChunkGate = new Promise<void>((resolve) => {
			releaseFirstChunk = resolve;
		});
		const streamIter = runner
			.generateStream({
				...BASE_ARGS,
				promptTokens: new Int32Array([1]),
				onTextChunk: () => firstChunkGate,
			})
			[Symbol.asyncIterator]();

		// Pull the first step: stream A is open and parked awaiting its chunk gate.
		const first = await streamIter.next();
		expect(first.value?.text).toBe("a");
		expect(events).toEqual(["open"]);

		// A second generation on the SAME pinned slot must not open a session
		// while A is still in flight — interleaving would corrupt the slot's KV.
		const second = runner.generateWithUsage({
			...BASE_ARGS,
			promptTokens: new Int32Array([1]),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(["open"]);

		releaseFirstChunk();
		// Drain A, then let B finish.
		while (!(await streamIter.next()).done) {
			// draining
		}
		const result = await second;
		expect(result.text).toBe("ab");
		expect(events).toEqual(["open", "close", "open", "close"]);
	});
});
