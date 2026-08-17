import { describe, expect, it } from "vitest";
import {
	assertCanonicalEmbeddingConfig,
	CANONICAL_EMBEDDING_DIMENSION,
	CANONICAL_EMBEDDING_MODEL,
	isCanonicalEmbeddingModel,
} from "./embeddings";

describe("canonical embedding contract", () => {
	it("pins gte-small to 384 dimensions across hosted and local aliases", () => {
		expect(CANONICAL_EMBEDDING_MODEL).toBe("thenlper/gte-small");
		expect(CANONICAL_EMBEDDING_DIMENSION).toBe(384);
		expect(isCanonicalEmbeddingModel("gte-small_fp16.gguf")).toBe(true);
		expect(isCanonicalEmbeddingModel("ChristianAzinn/gte-small-gguf")).toBe(
			true,
		);
		expect(() =>
			assertCanonicalEmbeddingConfig("thenlper/gte-small", 384),
		).not.toThrow();
	});

	it("fails closed on a different model or width", () => {
		expect(() =>
			assertCanonicalEmbeddingConfig("text-embedding-3-small", 384),
		).toThrow(/model mismatch/);
		expect(() =>
			assertCanonicalEmbeddingConfig("thenlper/gte-small", 1536),
		).toThrow(/dimension mismatch/);
	});
});
