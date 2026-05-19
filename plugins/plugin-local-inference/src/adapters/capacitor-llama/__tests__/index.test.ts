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
		it("registers TEXT_SMALL, TEXT_LARGE, TEXT_EMBEDDING", () => {
			expect(typeof localAiPlugin.models?.TEXT_SMALL).toBe("function");
			expect(typeof localAiPlugin.models?.TEXT_LARGE).toBe("function");
			expect(typeof localAiPlugin.models?.TEXT_EMBEDDING).toBe("function");
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
			expect(MODEL_SPECS.embedding.name).toContain("eliza-1");
		});

		it("declares 1024 embedding dimensions to match plugin-local-inference", () => {
			expect(MODEL_SPECS.embedding.dimensions).toBe(1024);
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
		});
	});
});
