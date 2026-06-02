import { afterEach, describe, expect, it } from "vitest";
import { shouldWarmupLocalEmbeddingModel } from "./embedding-warmup-policy";

const ENV_KEYS = [
	"ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP",
	"ELIZA_DISABLE_LOCAL_EMBEDDINGS",
	"ELIZA_CLOUD_EMBEDDINGS_DISABLED",
	"ELIZAOS_CLOUD_USE_EMBEDDINGS",
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
		process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "1";

		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("skips warmup when local embeddings are disabled", () => {
		process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1";

		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});

	it("skips warmup when cloud embeddings are enabled", () => {
		process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "1";

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
});
