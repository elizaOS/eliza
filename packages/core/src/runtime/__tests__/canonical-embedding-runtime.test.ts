/** Runtime-level attestation and output validation for semantic embeddings. */
import { describe, expect, it, vi } from "vitest";
import {
	CANONICAL_EMBEDDING_DIMENSION,
	CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
} from "../../constants/embeddings";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { ModelType } from "../../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "CanonicalEmbeddingRuntimeAgent",
			bio: "Tests the canonical embedding runtime boundary.",
		},
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

function vector(a = 3, b = 4): number[] {
	const result = new Array<number>(CANONICAL_EMBEDDING_DIMENSION).fill(0);
	result[0] = a;
	result[1] = b;
	return result;
}

const canonicalMetadata = {
	embeddingSpaceFingerprint: CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
} as const;

function register(
	runtime: AgentRuntime,
	modelType:
		| typeof ModelType.TEXT_EMBEDDING
		| typeof ModelType.TEXT_EMBEDDING_BATCH,
	handler: (params: unknown) => unknown | Promise<unknown>,
	metadata: { embeddingSpaceFingerprint?: string } = canonicalMetadata,
): void {
	runtime.registerModel(
		modelType,
		async (_runtime, params) => handler(params),
		"canonical-test",
		100,
		metadata,
	);
}

describe("canonical embedding registration attestation", () => {
	it.each([
		["missing", {}],
		["mismatched", { embeddingSpaceFingerprint: "legacy-gte:384:v1" }],
	] as const)("makes a %s fingerprint ineligible", (_label, metadata) => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING, () => vector(), metadata);

		expect(runtime.getModel(ModelType.TEXT_EMBEDDING)).toBeUndefined();
		expect(runtime.getModelRegistrations()).toEqual([
			expect.objectContaining({
				modelType: ModelType.TEXT_EMBEDDING,
				metadata,
			}),
		]);
	});

	it("selects an exactly-attested single and batch handler", () => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING, () => vector());
		register(runtime, ModelType.TEXT_EMBEDDING_BATCH, () => [vector()]);

		expect(runtime.getModel(ModelType.TEXT_EMBEDDING)).toBeTypeOf("function");
		expect(runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH)).toBeTypeOf(
			"function",
		);
	});
});

describe("canonical embedding input validation", () => {
	it("trims cloned single and batch inputs before provider dispatch", async () => {
		const runtime = makeRuntime();
		const single = vi.fn(() => vector());
		const batch = vi.fn((params: unknown) => {
			const texts = (params as { texts: string[] }).texts;
			return texts.map(() => vector());
		});
		register(runtime, ModelType.TEXT_EMBEDDING, single);
		register(runtime, ModelType.TEXT_EMBEDDING_BATCH, batch);
		const singleParams = { text: "  remember this  " };
		const batchParams = { texts: ["  one", "two  "] };

		await runtime.useModel(ModelType.TEXT_EMBEDDING, singleParams);
		await runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, batchParams);

		expect(single).toHaveBeenCalledWith(
			expect.objectContaining({ text: "remember this" }),
		);
		expect(batch).toHaveBeenCalledWith(
			expect.objectContaining({ texts: ["one", "two"] }),
		);
		expect(singleParams.text).toBe("  remember this  ");
		expect(batchParams.texts).toEqual(["  one", "two  "]);
	});

	it.each([
		["blank single", ModelType.TEXT_EMBEDDING, { text: "   " }],
		["over-limit single", ModelType.TEXT_EMBEDDING, { text: "x".repeat(511) }],
		[
			"ill-formed single",
			ModelType.TEXT_EMBEDDING,
			{ text: "bad \uD83D input" },
		],
		[
			"non-string batch member",
			ModelType.TEXT_EMBEDDING_BATCH,
			{ texts: ["ok", 42] },
		],
		[
			"blank batch member",
			ModelType.TEXT_EMBEDDING_BATCH,
			{ texts: ["ok", " "] },
		],
	] as const)(
		"rejects %s before invoking a provider",
		async (_label, modelType, params) => {
			const runtime = makeRuntime();
			const handler = vi.fn(() =>
				modelType === ModelType.TEXT_EMBEDDING
					? vector()
					: [vector(), vector()],
			);
			register(runtime, modelType, handler);

			await expect(
				runtime.useModel(modelType, params as never),
			).rejects.toMatchObject({ code: "EMBEDDING_MODEL_INPUT_INVALID" });
			expect(handler).not.toHaveBeenCalled();
		},
	);
});

describe("canonical embedding output validation", () => {
	it("L2-normalizes a finite canonical single vector", async () => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING, () => vector());

		const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: "remember this",
		});
		expect(result).toHaveLength(CANONICAL_EMBEDDING_DIMENSION);
		expect(result[0]).toBeCloseTo(0.6);
		expect(result[1]).toBeCloseTo(0.8);
		expect(Math.hypot(...result)).toBeCloseTo(1);
	});

	it.each([
		["wrong-width", new Array(383).fill(1)],
		["non-finite", Object.assign(vector(), { 2: Number.NaN })],
		["zero", new Array(CANONICAL_EMBEDDING_DIMENSION).fill(0)],
		["nested", [vector()]],
	] as const)("rejects a %s single output", async (_label, output) => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING, () => output);

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "invalid" }),
		).rejects.toMatchObject({ code: "EMBEDDING_MODEL_OUTPUT_INVALID" });
	});

	it("allows an exact-width finite null boot marker without normalization", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn((params: unknown) =>
			params === null ? vector(0.1, 0) : vector(),
		);
		register(runtime, ModelType.TEXT_EMBEDDING, handler);

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, null),
		).resolves.toEqual(vector(0.1, 0));
	});

	it.each([
		["wrong-width", new Array(383).fill(0)],
		[
			"non-finite",
			Object.assign(new Array(CANONICAL_EMBEDDING_DIMENSION).fill(0), {
				2: Number.NaN,
			}),
		],
		["nested", [new Array(CANONICAL_EMBEDDING_DIMENSION).fill(0)]],
	] as const)("rejects a %s null boot marker", async (_label, output) => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING, () => output);

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, null),
		).rejects.toMatchObject({ code: "EMBEDDING_MODEL_OUTPUT_INVALID" });
	});

	it("validates count and L2-normalizes every batch vector", async () => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING_BATCH, () => [
			vector(3, 4),
			vector(5, 12),
		]);

		const result = await runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
			texts: ["one", "two"],
		});
		expect(result).toHaveLength(2);
		expect(result[0]?.[0]).toBeCloseTo(0.6);
		expect(result[0]?.[1]).toBeCloseTo(0.8);
		expect(result[1]?.[0]).toBeCloseTo(5 / 13);
		expect(result[1]?.[1]).toBeCloseTo(12 / 13);
	});

	it.each([
		["count-mismatch", [vector()]],
		["wrong-width", [vector(), new Array(383).fill(1)]],
		["non-finite", [vector(), Object.assign(vector(), { 2: Infinity })]],
		["zero", [vector(), new Array(CANONICAL_EMBEDDING_DIMENSION).fill(0)]],
		["nested", [vector(), [[1]]]],
	] as const)("rejects a %s batch output", async (_label, output) => {
		const runtime = makeRuntime();
		register(runtime, ModelType.TEXT_EMBEDDING_BATCH, () => output);

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
				texts: ["one", "two"],
			}),
		).rejects.toMatchObject({ code: "EMBEDDING_MODEL_OUTPUT_INVALID" });
	});

	it("rejects a sparse batch output even when its length matches", async () => {
		const runtime = makeRuntime();
		const sparse = new Array<number[]>(2);
		sparse[1] = vector();
		register(runtime, ModelType.TEXT_EMBEDDING_BATCH, () => sparse);

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
				texts: ["one", "two"],
			}),
		).rejects.toMatchObject({ code: "EMBEDDING_MODEL_OUTPUT_INVALID" });
	});
});
