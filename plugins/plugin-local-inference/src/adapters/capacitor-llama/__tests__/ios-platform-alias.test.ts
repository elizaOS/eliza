/** Exercises real brand alias resolution and embedding-handler dispatch with a controlled native boundary. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { getBootConfig, setBootConfig } from "@elizaos/core/config/boot-config-store";
import { prepareBgeEmbeddingInput } from "@elizaos/plugin-native-inference/model-catalog/bge-input";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	space: "BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1",
	initMobileBgeEmbedding: vi.fn(),
	initCapacitorLlama: vi.fn(),
}));

vi.mock("../..", () => ({
	createLocalInferenceModelHandlers: vi.fn(() => ({})),
	isLocalInferenceUnavailableError: vi.fn(() => false),
}));
vi.mock("../loader", () => native);
vi.mock("../../../runtime/embedding-vector-space", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../runtime/embedding-vector-space")
	>()),
	verifyBgeEmbeddingFile: () => native.space,
}));

const savedConfig = getBootConfig();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ios-platform-alias-"));
afterEach(() => {
	setBootConfig(savedConfig);
	vi.unstubAllEnvs();
	fs.rmSync(directory, { recursive: true, force: true });
});

it("selects the identity-checked iOS encoder from a branded platform alias", async () => {
	setBootConfig({
		...savedConfig,
		envAliases: [["ACME_PLATFORM", "ELIZA_PLATFORM"]],
	});
	vi.stubEnv("ELIZA_PLATFORM", undefined);
	vi.stubEnv("ACME_PLATFORM", "ios");
	vi.stubEnv("MODELS_DIR", path.join(directory, "models"));
	vi.stubEnv("CACHE_DIR", path.join(directory, "cache"));
	const input = "Preserve this complete branded iOS request.";
	const prepared = prepareBgeEmbeddingInput(input);
	const embedding = vi.fn(async () => ({
		embedding: [3, 4, ...Array.from({ length: 382 }, () => 0)],
		embeddingSpace: native.space,
		tokens: prepared.tokenIds.length,
		tokenIds: prepared.tokenIds,
	}));
	native.initMobileBgeEmbedding.mockResolvedValue({
		tokenize: async () => ({ tokens: prepared.tokenIds }),
		embedding,
		release: async () => undefined,
	});
	native.initCapacitorLlama.mockRejectedValue(new Error("wrong encoder route"));
	const { localAiPlugin } = await import("../index");
	const runtime = {
		getSetting: () => undefined,
		emitEvent: async () => undefined,
	} as unknown as IAgentRuntime;
	const result = await localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(
		runtime,
		{ text: "Preserve this complete branded iOS request." } as never,
	);
	expect(result).toEqual([0.6, 0.8, ...Array.from({ length: 382 }, () => 0)]);
	expect(native.initMobileBgeEmbedding).toHaveBeenCalledWith(
		expect.stringContaining("bge-small-en-v1.5-f16.gguf"),
		512,
	);
	expect(native.initCapacitorLlama).not.toHaveBeenCalled();
	expect(embedding).toHaveBeenCalledWith(
		"Preserve this complete branded iOS request.",
		{
			embd_normalize: 2,
			expectedTokenIds: prepared.tokenIds,
			embeddingSpace: native.space,
		},
	);
	expect(process.env.ELIZA_PLATFORM).toBeUndefined();
});
