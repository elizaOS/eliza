/** Deterministic tests for the documents pipeline's canonical runtime embedding boundary. */
import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { generateTextEmbedding } from "./llm.ts";

function canonicalVector(): number[] {
	return Array.from({ length: 384 }, (_, index) => (index === 0 ? 2 : 0));
}

function makeRuntime(result: number[]) {
	const useModel = vi.fn(async () => result);
	const runtime = {
		getSetting: vi.fn((key: string) => {
			if (key === "EMBEDDING_PROVIDER") return "google";
			if (key === "GOOGLE_EMBEDDING_MODEL") return "gemini-embedding-001";
			return undefined;
		}),
		reportError: vi.fn(),
		useModel,
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

describe("documents canonical embeddings", () => {
	it("routes through runtime TEXT_EMBEDDING despite legacy direct-provider settings", async () => {
		const { runtime, useModel } = makeRuntime(canonicalVector());

		const result = await generateTextEmbedding(runtime, "remember this");

		expect(useModel).toHaveBeenCalledOnce();
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
			text: "remember this",
		});
		expect(result.embedding).toHaveLength(384);
		expect(result.embedding[0]).toBe(1);
	});

	it("fails closed on a wrong-width or zero runtime vector", async () => {
		await expect(
			generateTextEmbedding(makeRuntime(new Array(385).fill(1)).runtime, "x"),
		).rejects.toThrow("Embedding dimension mismatch");
		await expect(
			generateTextEmbedding(makeRuntime(new Array(384).fill(0)).runtime, "x"),
		).rejects.toThrow("zero or invalid L2 norm");
	});
});
