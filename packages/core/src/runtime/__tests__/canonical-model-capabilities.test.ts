import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSetting: vi.fn(),
}));

vi.mock("../types/model.ts", () => ({
	ModelType: { TEXT_EMBEDDING: "TEXT_EMBEDDING" },
	TEXT_GENERATION_MODEL_TYPES: ["TEXT_GENERATION"],
}));

import {
	CANONICAL_EMBEDDING_CAPABILITY_SETTING,
	CANONICAL_TEXT_CAPABILITY_SETTING,
	isCanonicalModelCapabilityDisabled,
} from "../canonical-model-capabilities.ts";

function runtime() {
	return { getSetting: mocks.getSetting } as never;
}

describe("isCanonicalModelCapabilityDisabled", () => {
	it("checks the text setting for generation model types", () => {
		mocks.getSetting.mockReturnValue("false");
		expect(
			isCanonicalModelCapabilityDisabled(runtime(), "TEXT_GENERATION"),
		).toBe(true);
		expect(mocks.getSetting).toHaveBeenCalledWith(
			CANONICAL_TEXT_CAPABILITY_SETTING,
		);
	});

	it("checks the embedding setting for embeddings", () => {
		mocks.getSetting.mockReturnValue(false);
		expect(
			isCanonicalModelCapabilityDisabled(runtime(), "TEXT_EMBEDDING"),
		).toBe(true);
		expect(mocks.getSetting).toHaveBeenCalledWith(
			CANONICAL_EMBEDDING_CAPABILITY_SETTING,
		);
	});

	it("treats enabled/undefined as not disabled", () => {
		mocks.getSetting.mockReturnValue("true");
		expect(
			isCanonicalModelCapabilityDisabled(runtime(), "TEXT_GENERATION"),
		).toBe(false);
		mocks.getSetting.mockReturnValue(undefined);
		expect(
			isCanonicalModelCapabilityDisabled(runtime(), "TEXT_GENERATION"),
		).toBe(false);
	});
});
