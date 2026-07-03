import { describe, expect, it } from "vitest";
import {
	isTextGenerationModelType,
	ModelType,
	TEXT_GENERATION_MODEL_TYPES,
} from "./model";

describe("text generation model type contract", () => {
	it("recognizes every declared text generation model type", () => {
		for (const modelType of TEXT_GENERATION_MODEL_TYPES) {
			expect(isTextGenerationModelType(modelType)).toBe(true);
		}
	});

	it("excludes non-text-generation model types", () => {
		expect(isTextGenerationModelType(ModelType.TEXT_EMBEDDING)).toBe(false);
		expect(isTextGenerationModelType(ModelType.IMAGE_DESCRIPTION)).toBe(false);
		expect(isTextGenerationModelType(ModelType.TEXT_TO_SPEECH)).toBe(false);
		expect(isTextGenerationModelType("TEXT_TOKENIZER_ENCODE")).toBe(false);
		expect(isTextGenerationModelType("OBJECT_SMALL")).toBe(false);
	});

	it("normalizes string casing and whitespace", () => {
		expect(isTextGenerationModelType(" response_handler ")).toBe(true);
		expect(isTextGenerationModelType("reasoning_large")).toBe(true);
	});
});
