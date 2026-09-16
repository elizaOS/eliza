/** Exercises native embedding normalization and rejects incompatible pooling configurations. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	embedCompleteInput,
	normalizeEmbeddingVector,
	resolveBgeContextLimit,
	resolveEmbeddingPooling,
	verifyBgeEmbeddingBundle,
} from "./embedding-vector-space";

describe("embedding vector space", () => {
	it("normalizes proportional vectors identically without overflowing", () => {
		expect(normalizeEmbeddingVector([3, 4])).toEqual(
			normalizeEmbeddingVector([3e200, 4e200]),
		);
		const vector = normalizeEmbeddingVector([3, 4]);
		expect(Math.hypot(...vector)).toBeCloseTo(1);
		expect(vector[0] / vector[1]).toBeCloseTo(3 / 4);
	});
	it.each([[], [0, 0], [NaN, 1], [Infinity, 1]])(
		"rejects unusable embeddings %j",
		(vector) => {
			expect(() => normalizeEmbeddingVector(vector)).toThrow();
		},
	);
	it("requires the same CLS space for BGE whether selected implicitly or explicitly", () => {
		const model = "/models/bge-small-en-v1.5-f16.gguf";
		expect(resolveEmbeddingPooling(model)).toBe(
			resolveEmbeddingPooling(model, "cls"),
		);
		expect(() => resolveEmbeddingPooling(model, "mean")).toThrow(/CLS/);
		expect(() => resolveEmbeddingPooling(model, "last")).toThrow(/CLS/);
		expect(() => resolveEmbeddingPooling("custom.gguf", "typo")).toThrow(
			/Unsupported/,
		);
	});
});

describe("complete encoder input", () => {
	it("rejects the complete over-limit input before calling the native encoder", () => {
		const input = "complete input with a distinct tail";
		let dispatched = false;
		expect(() =>
			embedCompleteInput(
				input,
				(text) => {
					expect(text).toBe(input);
					return new Int32Array(513);
				},
				() => {
					dispatched = true;
					return new Float32Array([1]);
				},
				512,
			),
		).toThrow(/513 tokens/);
		expect(dispatched).toBe(false);
	});
	it("passes the entire boundary-sized input to the encoder", () => {
		const input = "full source including the final word";
		let received = "";
		const vector = embedCompleteInput(
			input,
			() => new Int32Array(512),
			(text) => {
				received = text;
				return new Float32Array([3, 4]);
			},
			resolveBgeContextLimit("1024"),
		);
		expect(received).toBe(input);
		expect(Array.from(vector)).toEqual([3, 4]);
	});
	it("honors a smaller native context instead of allowing truncation", () => {
		expect(() =>
			embedCompleteInput(
				"complete text",
				() => new Int32Array(129),
				() => {
					throw new Error("must not dispatch");
				},
				resolveBgeContextLimit("128"),
			),
		).toThrow(/supports 128/);
	});
	it.each(["0", "-1", "128junk", "1.5", "2147483648"])(
		"rejects an ambiguous native context %s",
		(value) => {
			expect(() => resolveBgeContextLimit(value)).toThrow();
		},
	);
});

it("rejects a misleading BGE filename and an ambiguous native bundle", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "eliza-bge-provenance-"));
	try {
		mkdirSync(path.join(root, "text"));
		writeFileSync(
			path.join(root, "text", "bge-small-en-v1.5-f16.gguf"),
			"different model bytes",
		);
		expect(() =>
			verifyBgeEmbeddingBundle(root, "bge-small-en-v1.5-f16.gguf"),
		).toThrow(/pinned model/);
		writeFileSync(path.join(root, "text", "other.gguf"), "another model");
		expect(() =>
			verifyBgeEmbeddingBundle(root, "bge-small-en-v1.5-f16.gguf"),
		).toThrow(/exactly one GGUF/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
