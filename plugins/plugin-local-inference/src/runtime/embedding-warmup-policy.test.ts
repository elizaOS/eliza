/**
 * Unit tests for local embedding ownership and GGUF prefetch policy. Provider
 * ownership remains local when packaged startup skips only the eager download.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	shouldUseLocalEmbeddingModel,
	shouldWarmupLocalEmbeddingModel,
} from "./embedding-warmup-policy";

const ENV_KEYS = [
	"ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP",
	"ELIZA_DISABLE_LOCAL_EMBEDDINGS",
	"ELIZA_CLOUD_EMBEDDINGS_DISABLED",
	"ELIZAOS_CLOUD_USE_EMBEDDINGS",
	"EMBEDDING_PROVIDER",
	"EMBEDDING_BASE_URL",
] as const;

afterEach(() => {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
});

describe("shouldWarmupLocalEmbeddingModel", () => {
	it("warms local embeddings by default for local runtimes", () => {
		expect(shouldWarmupLocalEmbeddingModel()).toBe(true);
	});

	it("lets packaged desktop startup skip the large embedding prefetch", () => {
		process.env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP = "1";

		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
		expect(shouldUseLocalEmbeddingModel()).toBe(true);
	});

	it("skips warmup when local embeddings are disabled", () => {
		process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1";

		expect(shouldUseLocalEmbeddingModel()).toBe(false);
		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("skips warmup when cloud embeddings are enabled", () => {
		process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "1";

		expect(shouldUseLocalEmbeddingModel()).toBe(false);
		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("keeps local warmup when cloud embeddings are explicitly disabled", () => {
		process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "1";

		expect(shouldWarmupLocalEmbeddingModel()).toBe(true);
	});

	it("lets explicit startup skip win over cloud embedding disablement", () => {
		process.env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP = "true";
		process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "true";

		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("cedes ownership to an operator-configured embedding endpoint", () => {
		process.env.EMBEDDING_BASE_URL = "https://api.openai.com/v1";

		expect(shouldUseLocalEmbeddingModel()).toBe(false);
		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("cedes ownership to an operator-configured non-local provider", () => {
		process.env.EMBEDDING_PROVIDER = "openai";

		expect(shouldUseLocalEmbeddingModel()).toBe(false);
		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("keeps local ownership when the operator explicitly picks local", () => {
		process.env.EMBEDDING_PROVIDER = "local";
		process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:8290/v1";

		expect(shouldUseLocalEmbeddingModel()).toBe(true);
	});

	it("cedes ownership to a configured endpoint even when cloud embeddings are disabled", () => {
		process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "1";
		process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:8290/v1";

		expect(shouldUseLocalEmbeddingModel()).toBe(false);
	});
});
