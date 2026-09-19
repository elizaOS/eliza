/** Exercises real brand alias resolution and embedding-handler dispatch with a controlled native boundary. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { getBootConfig, setBootConfig } from "@elizaos/shared";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	space: "BAAI/bge-small-en-v1.5:cls:l2:384",
	initIosBgeEmbedding: vi.fn(),
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
	const embedding = vi.fn(async () => ({
		embedding: [3, 4, ...Array.from({ length: 382 }, () => 0)],
		embeddingSpace: native.space,
		tokens: 3,
	}));
	native.initIosBgeEmbedding.mockResolvedValue({
		tokenize: async () => ({ tokens: [1, 2, 3] }),
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
	expect(native.initIosBgeEmbedding).toHaveBeenCalledWith(
		expect.stringContaining("bge-small-en-v1.5-f16.gguf"),
		512,
	);
	expect(native.initCapacitorLlama).not.toHaveBeenCalled();
	expect(embedding).toHaveBeenCalledWith(
		"Preserve this complete branded iOS request.",
		{ embd_normalize: 2 },
	);
	expect(process.env.ELIZA_PLATFORM).toBeUndefined();
});
