/**
 * Embedding-handler wiring tests.
 *
 * Pins the runtime contract for `useModel(TEXT_EMBEDDING, ...)`:
 *   - the unified local provider registers a TEXT_EMBEDDING handler,
 *   - the handler dispatches `embed({ input })` onto the loader registered
 *     as "localInferenceLoader",
 *   - null/warmup probes throw LOCAL_INFERENCE_UNAVAILABLE rather than
 *     synthesizing a fake vector (Commandment 8: don't hide broken pipelines),
 *   - missing backend service throws so callers can fall through to another
 *     real embedding provider instead of persisting fake zero vectors,
 *   - the same input always returns the exact array the loader returned
 *     (determinism is the *loader's* contract — the provider does not
 *     re-quantize or perturb).
 *
 * The catalog (`packages/shared/src/local-inference/catalog.ts`) declares
 * a single 1024-dim Matryoshka embedding region for every tier that has
 * `hasEmbedding: true` (every tier except 0_8b/2b, which serve embeddings
 * by pooling the text backbone via the lazily-started embedding sidecar).
 * The shape is enforced by `EMBEDDING_FULL_DIM = 1024` and
 * `isValidEmbeddingDim`. The provider passes the bytes through verbatim
 * — this test asserts that pass-through, not the dimensionality of the
 * actual GGUF (that lives in `services/voice/embedding.test.ts`).
 */
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
} from "../src/provider.ts";

function runtimeWithService(service: Record<string, unknown>) {
	return {
		getService: vi.fn((name: string) =>
			name === "localInferenceLoader" ? service : null,
		),
	};
}

function makeUnitVector(dim: number, seed = 0.1): number[] {
	// Deterministic synthetic vector; the loader is mocked so the actual
	// bytes don't matter for shape stability — only that the provider
	// returns exactly what the loader returned.
	const v: number[] = new Array(dim);
	for (let i = 0; i < dim; i += 1) v[i] = (i + 1) * seed;
	return v;
}

describe("provider TEXT_EMBEDDING dispatch", () => {
	it("registers a TEXT_EMBEDDING handler", () => {
		const handlers = createLocalInferenceModelHandlers();
		expect(typeof handlers[ModelType.TEXT_EMBEDDING]).toBe("function");
	});

	it("dispatches embed({ input }) on the loader and returns the raw float array", async () => {
		const expected = makeUnitVector(1024);
		const embed = vi.fn(async (args: { input: string }) => {
			expect(args.input).toBe("hello world");
			return expected;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const result = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "hello world",
		} as never);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual(expected);
		expect((result as number[]).length).toBe(1024);
	});

	it("accepts a raw string input (action-runner shape) without re-wrapping", async () => {
		const expected = makeUnitVector(1024, 0.2);
		const embed = vi.fn(async (args: { input: string }) => {
			expect(args.input).toBe("plain string");
			return expected;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const result = await handlers[ModelType.TEXT_EMBEDDING]?.(
			runtime as never,
			"plain string" as never,
		);
		expect(result).toEqual(expected);
	});

	it("accepts the { embedding: number[] } loader shape too", async () => {
		const expected = makeUnitVector(1024, 0.3);
		const embed = vi.fn(async () => ({ embedding: expected }));
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const result = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "shape variant",
		} as never);
		expect(result).toEqual(expected);
	});

	it("returns the *same* vector for the same input — pass-through, no perturbation", async () => {
		// Deterministic-for-same-input is a *loader* contract; the provider
		// promises pass-through. Two calls with the same loader and the
		// same input must yield equal arrays (by deep equality).
		let counter = 0;
		const fixed = makeUnitVector(1024, 0.4);
		const embed = vi.fn(async () => {
			counter += 1;
			return fixed;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const a = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "stable",
		} as never);
		const b = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "stable",
		} as never);

		expect(counter).toBe(2);
		expect(a).toEqual(b);
		expect((a as number[]).length).toBe((b as number[]).length);
	});

	it("rejects null warmup probes — must NOT serve a fake zero vector (Commandment 8)", async () => {
		const embed = vi.fn();
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		let caught: unknown;
		try {
			await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, null as never);
		} catch (err) {
			caught = err;
		}
		expect(isLocalInferenceUnavailableError(caught)).toBe(true);
		expect((caught as { reason?: string }).reason).toBe("invalid_input");
		expect(embed).not.toHaveBeenCalled();
	});

	it("rejects empty-string input", async () => {
		const embed = vi.fn();
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_input",
		});
		expect(embed).not.toHaveBeenCalled();
	});

	it("rejects a loader that returns a non-numeric array (invalid_output)", async () => {
		const embed = vi.fn(async () => ["not", "a", "vector"] as unknown as number[]);
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "hi",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_output",
		});
	});

	it("rejects when no loader is registered instead of returning zero vectors", async () => {
		const handlers = createLocalInferenceModelHandlers();
		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.({} as never, {
				text: "hi",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "backend_unavailable",
		});
	});

	it("emits capability_unavailable when the loader has no `embed`", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({});

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "hi",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "capability_unavailable",
		});
	});
});

describe("embedding dim contract (1024 — Matryoshka-truncatable)", () => {
	it("the catalog's full embedding width is 1024", async () => {
		// EMBEDDING_FULL_DIM is the single point of truth — every tier with
		// `hasEmbedding: true` ships the same 1024-dim Matryoshka region.
		// Smaller widths (768/512/256/128/64) are truncations of the same
		// vector. Asserting this here pins the shape contract for callers
		// who don't import the voice subpackage.
		const mod = await import(
			"../src/services/voice/embedding"
		);
		expect(mod.EMBEDDING_FULL_DIM).toBe(1024);
		expect(mod.EMBEDDING_MATRYOSHKA_DIMS).toEqual([
			64, 128, 256, 512, 768, 1024,
		]);
		expect(mod.isValidEmbeddingDim(1024)).toBe(true);
		expect(mod.isValidEmbeddingDim(1025)).toBe(false);
	});
});
