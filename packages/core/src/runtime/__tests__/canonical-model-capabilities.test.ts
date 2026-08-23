/**
 * Unit coverage for the canonical model capability gate. Deterministic: the
 * real `ModelType` / `TEXT_GENERATION_MODEL_TYPES` tables are used and only the
 * runtime's `getSetting` accessor is a stub.
 */

import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model.ts";
import {
	CANONICAL_EMBEDDING_CAPABILITY_SETTING,
	CANONICAL_TEXT_CAPABILITY_SETTING,
	isCanonicalModelCapabilityDisabled,
} from "../canonical-model-capabilities.ts";

function runtimeWith(setting: unknown) {
	const getSetting = vi.fn().mockReturnValue(setting);
	return { runtime: { getSetting } as never, getSetting };
}

describe("isCanonicalModelCapabilityDisabled", () => {
	it("checks the text setting for generation model types", () => {
		const { runtime, getSetting } = runtimeWith("false");
		expect(
			isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_LARGE),
		).toBe(true);
		expect(getSetting).toHaveBeenCalledWith(CANONICAL_TEXT_CAPABILITY_SETTING);
	});

	it("checks the embedding setting for embeddings", () => {
		const { runtime, getSetting } = runtimeWith(false);
		expect(
			isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_EMBEDDING),
		).toBe(true);
		expect(getSetting).toHaveBeenCalledWith(
			CANONICAL_EMBEDDING_CAPABILITY_SETTING,
		);
	});

	it("treats enabled and undefined settings as not disabled", () => {
		const enabled = runtimeWith("true");
		expect(
			isCanonicalModelCapabilityDisabled(enabled.runtime, ModelType.TEXT_SMALL),
		).toBe(false);
		const unset = runtimeWith(undefined);
		expect(
			isCanonicalModelCapabilityDisabled(unset.runtime, ModelType.TEXT_SMALL),
		).toBe(false);
	});

	it("does not consult any setting for unrelated model types", () => {
		const { runtime, getSetting } = runtimeWith("false");
		expect(isCanonicalModelCapabilityDisabled(runtime, ModelType.IMAGE)).toBe(
			false,
		);
		expect(getSetting).not.toHaveBeenCalled();
	});
});
