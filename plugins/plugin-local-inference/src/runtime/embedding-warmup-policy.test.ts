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
	it("lets packaged desktop startup skip the large embedding prefetch", () => {
		process.env.ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP = "1";
		process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "1";

		expect(shouldWarmupLocalEmbeddingModel()).toBe(false);
	});
});
