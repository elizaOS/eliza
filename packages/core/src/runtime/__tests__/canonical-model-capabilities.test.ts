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

	it("parses case and whitespace variants of the string false", () => {
		for (const setting of [" FALSE ", "False", "fAlSe", "\tfalse\n"]) {
			const { runtime } = runtimeWith(setting);
			expect(
				isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_LARGE),
			).toBe(true);
			const embedding = runtimeWith(setting);
			expect(
				isCanonicalModelCapabilityDisabled(
					embedding.runtime,
					ModelType.TEXT_EMBEDDING,
				),
			).toBe(true);
		}
	});

	it("treats non-false string settings as enabled", () => {
		for (const setting of ["", "0", "falsey", "TRUE"]) {
			const { runtime } = runtimeWith(setting);
			expect(
				isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_LARGE),
			).toBe(false);
		}
	});

	it("treats boolean true and numeric settings as enabled", () => {
		for (const setting of [true, 1, 0]) {
			const { runtime } = runtimeWith(setting);
			expect(
				isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_SMALL),
			).toBe(false);
		}
	});

	it("checks every text generation type against the text setting", () => {
		const generationTypes = [
			ModelType.TEXT_NANO,
			ModelType.TEXT_SMALL,
			ModelType.TEXT_MEDIUM,
			ModelType.TEXT_LARGE,
			ModelType.TEXT_MEGA,
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.TEXT_REASONING_SMALL,
			ModelType.TEXT_REASONING_LARGE,
			ModelType.TEXT_COMPLETION,
		];
		for (const modelType of generationTypes) {
			const disabled = runtimeWith(false);
			expect(
				isCanonicalModelCapabilityDisabled(disabled.runtime, modelType),
			).toBe(true);
			const enabled = runtimeWith(undefined);
			expect(
				isCanonicalModelCapabilityDisabled(enabled.runtime, modelType),
			).toBe(false);
		}
	});

	it("treats embedding enabled and unset settings as not disabled", () => {
		const enabled = runtimeWith("true");
		expect(
			isCanonicalModelCapabilityDisabled(
				enabled.runtime,
				ModelType.TEXT_EMBEDDING,
			),
		).toBe(false);
		const unset = runtimeWith(undefined);
		expect(
			isCanonicalModelCapabilityDisabled(
				unset.runtime,
				ModelType.TEXT_EMBEDDING,
			),
		).toBe(false);
		expect(unset.getSetting).toHaveBeenCalledWith(
			CANONICAL_EMBEDDING_CAPABILITY_SETTING,
		);
	});

	it("routes batch embeddings through neither capability gate", () => {
		const { runtime, getSetting } = runtimeWith("false");
		expect(
			isCanonicalModelCapabilityDisabled(
				runtime,
				ModelType.TEXT_EMBEDDING_BATCH,
			),
		).toBe(false);
		expect(getSetting).not.toHaveBeenCalled();
	});

	it("consults exactly one setting per generation lookup", () => {
		const { runtime, getSetting } = runtimeWith(undefined);
		isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_MEDIUM);
		expect(getSetting).toHaveBeenCalledTimes(1);
		expect(getSetting).toHaveBeenCalledWith(CANONICAL_TEXT_CAPABILITY_SETTING);
	});
});
