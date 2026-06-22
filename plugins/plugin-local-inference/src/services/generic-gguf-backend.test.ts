/**
 * #8808 acceptance criterion 2 — GenericGgufBackend load + generate.
 *
 * The generic single-file GGUF backend is the explicit-`modelPath` text runtime
 * for a model the user downloaded/scanned (no Eliza-1 bundle). It is injected
 * with an `ExplicitModelPathLoader` so the dispatcher routing and the
 * load/generate lifecycle can be exercised without a native binding. These
 * tests drive a FAKE explicit-modelPath loader and assert:
 *   - load() opens the GGUF at the plan's explicit path,
 *   - generate() returns the loader-produced text,
 *   - currentModelPath()/hasLoadedModel() track the load/unload lifecycle,
 *   - generate() before load() throws (no silent empty completion),
 *   - load()-over-load() releases the prior context.
 */

import { describe, expect, it, vi } from "vitest";

import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaContext,
	CapacitorLlamaTokenData,
} from "../adapters/capacitor-llama/types";
import type { BackendPlan, GenerateArgs } from "./backend";
import {
	type ExplicitModelPathLoader,
	GenericGgufBackend,
} from "./generic-gguf-backend";

/**
 * A fake `CapacitorLlamaContext` that echoes a fixed completion and records the
 * params it was called with. Only the surface `GenericGgufBackend` touches
 * (`completion`, `release`) is implemented with real behaviour; the rest throw
 * so an accidental use is loud.
 */
function makeFakeContext(text: string): {
	ctx: CapacitorLlamaContext;
	completions: CapacitorLlamaCompletionParams[];
	released: () => number;
} {
	const completions: CapacitorLlamaCompletionParams[] = [];
	let releaseCount = 0;
	const unsupported = (method: string) => () => {
		throw new Error(`fake-context: ${method} not implemented`);
	};
	const ctx: CapacitorLlamaContext = {
		id: 1,
		gpu: false,
		reasonNoGPU: "",
		model: {} as CapacitorLlamaContext["model"],
		async completion(
			params: CapacitorLlamaCompletionParams,
			callback?: (data: CapacitorLlamaTokenData) => void,
		): Promise<CapacitorLlamaCompletionResult> {
			completions.push(params);
			// Stream the text in two pieces so the chunk callback is exercised.
			if (callback) {
				callback({ token: text.slice(0, 2) } as CapacitorLlamaTokenData);
				callback({ token: text.slice(2) } as CapacitorLlamaTokenData);
			}
			return {
				text,
				reasoning_content: "",
				tool_calls: [],
				content: text,
				chat_format: 0,
				tokens_predicted: 5,
				tokens_evaluated: 11,
				truncated: false,
				stopped_eos: true,
				stopped_word: "",
				stopped_limit: 0,
				stopping_word: "",
				context_full: false,
				interrupted: false,
				tokens_cached: 0,
				timings: {
					prompt_n: 11,
					prompt_ms: 1,
					prompt_per_token_ms: 1,
					prompt_per_second: 1,
					predicted_n: 5,
					predicted_ms: 1,
					predicted_per_token_ms: 1,
					predicted_per_second: 1,
				},
			};
		},
		stopCompletion: unsupported("stopCompletion") as never,
		tokenize: unsupported("tokenize") as never,
		detokenize: unsupported("detokenize") as never,
		embedding: unsupported("embedding") as never,
		bench: unsupported("bench") as never,
		async release(): Promise<void> {
			releaseCount += 1;
		},
	};
	return { ctx, completions, released: () => releaseCount };
}

/** A fake loader that records load() args and hands back a fake context. */
function makeFakeLoader(
	ctx: CapacitorLlamaContext,
	available = true,
): ExplicitModelPathLoader & {
	loadCalls: Array<{ modelPath: string; contextSize?: number; gpuLayers?: number }>;
} {
	const loadCalls: Array<{
		modelPath: string;
		contextSize?: number;
		gpuLayers?: number;
	}> = [];
	return {
		available: () => available,
		async load(args) {
			loadCalls.push(args);
			return ctx;
		},
		loadCalls,
	};
}

const PLAN: BackendPlan = {
	modelPath: "/models/llama-3.2-3b-q4.gguf",
	runtimeClass: "generic-gguf",
	overrides: { contextSize: 4096, gpuLayers: 32 },
};

const GENERATE: GenerateArgs = {
	prompt: "hello",
	maxTokens: 64,
	temperature: 0.2,
	topP: 0.95,
	stopSequences: ["</s>"],
};

describe("GenericGgufBackend (C2)", () => {
	it("reports availability from the injected loader", async () => {
		const { ctx } = makeFakeContext("ok");
		const servable = new GenericGgufBackend(makeFakeLoader(ctx, true));
		const unavailable = new GenericGgufBackend(makeFakeLoader(ctx, false));
		expect(await servable.available()).toBe(true);
		expect(await unavailable.available()).toBe(false);
	});

	it("load() opens the GGUF at the explicit path and tracks load state", async () => {
		const { ctx } = makeFakeContext("the answer is 4");
		const loader = makeFakeLoader(ctx);
		const backend = new GenericGgufBackend(loader);

		expect(backend.hasLoadedModel()).toBe(false);
		expect(backend.currentModelPath()).toBeNull();

		await backend.load(PLAN);

		expect(backend.hasLoadedModel()).toBe(true);
		expect(backend.currentModelPath()).toBe(PLAN.modelPath);
		expect(loader.loadCalls).toHaveLength(1);
		expect(loader.loadCalls[0]).toEqual({
			modelPath: "/models/llama-3.2-3b-q4.gguf",
			contextSize: 4096,
			gpuLayers: 32,
		});
	});

	it("generate() returns the produced text and streams chunks", async () => {
		const { ctx, completions } = makeFakeContext("the answer is 4");
		const backend = new GenericGgufBackend(makeFakeLoader(ctx));
		await backend.load(PLAN);

		const chunks: string[] = [];
		const text = await backend.generate({
			...GENERATE,
			onTextChunk: (c) => {
				chunks.push(c);
			},
		});

		expect(text).toBe("the answer is 4");
		expect(chunks.join("")).toBe("the answer is 4");
		// Generation params were forwarded to the explicit-path context verbatim.
		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({
			prompt: "hello",
			n_predict: 64,
			temperature: 0.2,
			top_p: 0.95,
			stop: ["</s>"],
		});
	});

	it("generateWithUsage() reports token usage from the completion result", async () => {
		const { ctx } = makeFakeContext("hi");
		const backend = new GenericGgufBackend(makeFakeLoader(ctx));
		await backend.load(PLAN);

		const result = await backend.generateWithUsage(GENERATE);
		expect(result.text).toBe("hi");
		expect(result.usage).toEqual({
			prompt_tokens: 11,
			completion_tokens: 5,
			total_tokens: 16,
		});
	});

	it("generate() before load() throws — no silent empty completion", async () => {
		const { ctx } = makeFakeContext("unused");
		const backend = new GenericGgufBackend(makeFakeLoader(ctx));
		await expect(backend.generate(GENERATE)).rejects.toThrow(
			/generate\(\) called before load\(\)/,
		);
	});

	it("unload() releases the context and clears load state", async () => {
		const { ctx, released } = makeFakeContext("x");
		const backend = new GenericGgufBackend(makeFakeLoader(ctx));
		await backend.load(PLAN);
		await backend.unload();
		expect(released()).toBe(1);
		expect(backend.hasLoadedModel()).toBe(false);
		expect(backend.currentModelPath()).toBeNull();
	});

	it("load()-over-load() releases the prior context before opening the next", async () => {
		const first = makeFakeContext("first");
		const second = makeFakeContext("second");
		const loader: ExplicitModelPathLoader = {
			available: () => true,
			load: vi
				.fn()
				.mockResolvedValueOnce(first.ctx)
				.mockResolvedValueOnce(second.ctx),
		};
		const backend = new GenericGgufBackend(loader);

		await backend.load(PLAN);
		await backend.load({
			modelPath: "/models/other.gguf",
			runtimeClass: "generic-gguf",
		});

		expect(first.released()).toBe(1);
		expect(backend.currentModelPath()).toBe("/models/other.gguf");
		expect(await backend.generate(GENERATE)).toBe("second");
	});
});
