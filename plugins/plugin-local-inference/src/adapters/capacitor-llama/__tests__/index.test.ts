/**
 * Structural tests for the Capacitor-llama `local-ai` plugin's metadata and
 * handler registration (name, description, init, model-handler presence). No
 * native model — pure object-shape assertions.
 */

import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { configSchema } from "../environment";
import { localAiPlugin } from "../index";
import { MODEL_SPECS } from "../types";

describe("Local AI Plugin (Capacitor-llama)", () => {
	describe("Plugin metadata", () => {
		it("registers as 'local-ai' for backwards compatibility", () => {
			expect(localAiPlugin.name).toBe("local-ai");
		});

		it("describes itself as Capacitor-backed", () => {
			expect(localAiPlugin.description).toBeDefined();
			expect(localAiPlugin.description?.toLowerCase()).toContain("capacitor");
		});

		it("exposes an init function", () => {
			expect(typeof localAiPlugin.init).toBe("function");
		});
	});

	describe("Model handlers", () => {
		it("registers TEXT_SMALL and TEXT_LARGE", () => {
			expect(typeof localAiPlugin.models?.TEXT_SMALL).toBe("function");
			expect(typeof localAiPlugin.models?.TEXT_LARGE).toBe("function");
		});

		it("does not advertise semantic embeddings without artifact attestation", () => {
			expect(localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
			expect(
				localAiPlugin.modelMetadata?.[ModelType.TEXT_EMBEDDING],
			).toBeUndefined();
		});

		it("registers other model types as compat thunks", () => {
			expect(typeof localAiPlugin.models?.[ModelType.IMAGE_DESCRIPTION]).toBe(
				"function",
			);
			expect(typeof localAiPlugin.models?.[ModelType.TRANSCRIPTION]).toBe(
				"function",
			);
			expect(typeof localAiPlugin.models?.[ModelType.TEXT_TO_SPEECH]).toBe(
				"function",
			);
		});
	});

	describe("Model bundle (MODEL_SPECS)", () => {
		it("includes small, medium, and embedding specs", () => {
			expect(MODEL_SPECS.small.name).toContain("eliza-1");
			expect(MODEL_SPECS.medium.name).toContain("eliza-1");
			// Embeddings use canonical BGE-small, not an eliza-1 chat GGUF.
			expect(MODEL_SPECS.embedding.name).toContain("bge-small");
			expect(MODEL_SPECS.embedding.repo).toBe(
				"CompendiumLabs/bge-small-en-v1.5-gguf",
			);
		});

		it("declares 384 embedding dimensions to match plugin-local-inference", () => {
			expect(MODEL_SPECS.embedding.dimensions).toBe(384);
		});

		it("does not declare any node-llama-cpp-specific fields", () => {
			// No tokenizer hash, no NAPI binding name — pure GGUF.
			const json = JSON.stringify(MODEL_SPECS);
			expect(json.toLowerCase()).not.toContain("node-llama-cpp");
		});
	});

	describe("environment configSchema", () => {
		it("parses an empty environment without throwing", () => {
			const parsed = configSchema.parse({});
			expect(parsed.LOCAL_SMALL_MODEL).toContain("eliza-1");
			expect(parsed.LOCAL_EMBEDDING_MODEL).toBe(
				"bge-small-en-v1.5-q4_k_m.gguf",
			);
		});

		it("rejects a same-width legacy embedding model or noncanonical width", () => {
			expect(() =>
				configSchema.parse({
					LOCAL_EMBEDDING_MODEL: "gte-small_fp16.gguf",
					LOCAL_EMBEDDING_DIMENSIONS: "384",
				}),
			).toThrow();
			expect(() =>
				configSchema.parse({ LOCAL_EMBEDDING_DIMENSIONS: "768" }),
			).toThrow();
		});
	});
});
