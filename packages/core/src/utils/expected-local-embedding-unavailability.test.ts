import { describe, expect, it } from "vitest";
import {
	isExpectedLocalEmbeddingUnavailability,
	modelProviderFailureDetails,
} from "./expected-local-embedding-unavailability";

describe("modelProviderFailureDetails", () => {
	it("returns empty object for non-object errors", () => {
		expect(modelProviderFailureDetails(null)).toEqual({});
		expect(modelProviderFailureDetails(undefined)).toEqual({});
		expect(modelProviderFailureDetails("string")).toEqual({});
		expect(modelProviderFailureDetails(42)).toEqual({});
	});

	it("extracts string fields from error objects", () => {
		const error = {
			code: "ERR_001",
			modelType: "TEXT_EMBEDDING",
			provider: "test",
			reason: "backend_unavailable",
		};
		expect(modelProviderFailureDetails(error)).toEqual(error);
	});

	it("ignores non-string fields", () => {
		const error = {
			code: 123,
			modelType: true,
			provider: null,
			reason: undefined,
		};
		expect(modelProviderFailureDetails(error)).toEqual({
			code: undefined,
			modelType: undefined,
			provider: undefined,
			reason: undefined,
		});
	});
});

describe("isExpectedLocalEmbeddingUnavailability", () => {
	it("returns true for expected unavailability", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
			reason: "backend_unavailable",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(true);
	});

	it("returns true for capability_unavailable", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
			reason: "capability_unavailable",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(true);
	});

	it("returns false for wrong code", () => {
		const error = {
			code: "OTHER_ERROR",
			modelType: "TEXT_EMBEDDING",
			reason: "backend_unavailable",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(false);
	});

	it("returns false for wrong modelType", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_SMALL",
			reason: "backend_unavailable",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(false);
	});

	it("returns false for unexpected reason", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
			reason: "invalid_input",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(false);
	});

	it("returns false for missing reason", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(false);
	});

	it("returns false for non-object errors", () => {
		expect(isExpectedLocalEmbeddingUnavailability(null)).toBe(false);
		expect(isExpectedLocalEmbeddingUnavailability("string")).toBe(false);
	});
});
