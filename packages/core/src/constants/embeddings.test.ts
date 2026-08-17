import { describe, expect, it } from "vitest";
import {
	assertCanonicalEmbeddingConfig,
	CANONICAL_EMBEDDING_DIMENSION,
	CANONICAL_EMBEDDING_MAX_CONTEXT_TOKENS,
	CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS,
	CANONICAL_EMBEDDING_MODEL,
	CANONICAL_EMBEDDING_NORMALIZATION,
	CANONICAL_EMBEDDING_POOLING,
	CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
	normalizeCanonicalEmbedding,
	prepareCanonicalEmbeddingInput,
} from "./embeddings";

describe("canonical embedding contract", () => {
	it("pins BGE-small to one explicit vector space", () => {
		expect(CANONICAL_EMBEDDING_MODEL).toBe("BAAI/bge-small-en-v1.5");
		expect(CANONICAL_EMBEDDING_DIMENSION).toBe(384);
		expect(CANONICAL_EMBEDDING_POOLING).toBe("mean");
		expect(CANONICAL_EMBEDDING_NORMALIZATION).toBe("l2");
		expect(CANONICAL_EMBEDDING_SPACE_FINGERPRINT).toBe(
			"BAAI/bge-small-en-v1.5:384:mean:l2:v1",
		);
		expect(() =>
			assertCanonicalEmbeddingConfig("BAAI/bge-small-en-v1.5", 384, "mean"),
		).not.toThrow();
	});

	it("rejects same-width legacy models and wrong pooling", () => {
		expect(() =>
			assertCanonicalEmbeddingConfig("thenlper/gte-small", 384),
		).toThrow(/model mismatch/i);
		expect(() =>
			assertCanonicalEmbeddingConfig("BAAI/bge-small-en-v1.5", 384, "cls"),
		).toThrow(/pooling mismatch/i);
	});

	it("normalizes finite vectors and rejects corrupt vectors", () => {
		const vector = new Array(384).fill(0);
		vector[0] = 3;
		vector[1] = 4;
		const normalized = normalizeCanonicalEmbedding(vector);
		expect(normalized[0]).toBeCloseTo(0.6);
		expect(normalized[1]).toBeCloseTo(0.8);
		expect(normalizeCanonicalEmbedding(normalized)).toEqual(normalized);
		expect(() => normalizeCanonicalEmbedding(new Array(384).fill(0))).toThrow(
			/zero/i,
		);
	});

	it("prepares input at the conservative 512-token context boundary", () => {
		expect(CANONICAL_EMBEDDING_MAX_CONTEXT_TOKENS).toBe(512);
		expect(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS).toBe(510);
		expect(
			prepareCanonicalEmbeddingInput(
				`  ${"x".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS)}  `,
			),
		).toBe("x".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS));
		expect(() =>
			prepareCanonicalEmbeddingInput(
				"x".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS + 1),
			),
		).toThrow(/maximum is 510/i);
	});

	it("rejects malformed, non-string, and blank inputs without rewriting", () => {
		expect(() => prepareCanonicalEmbeddingInput("bad \uD83D text")).toThrow(
			/well-formed Unicode/i,
		);
		expect(() =>
			prepareCanonicalEmbeddingInput({ text: "wrong shape" }),
		).toThrow(/must be a string/i);
		expect(() => prepareCanonicalEmbeddingInput("   ")).toThrow(/blank/i);
	});
});
