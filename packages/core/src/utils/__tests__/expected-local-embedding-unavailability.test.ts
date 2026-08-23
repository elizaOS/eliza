import { describe, expect, it } from "vitest";
import {
	isExpectedLocalEmbeddingUnavailability,
	modelProviderFailureDetails,
} from "./expected-local-embedding-unavailability.ts";

describe("modelProviderFailureDetails", () => {
	it("extracts string fields", () => {
		const details = modelProviderFailureDetails({
			code: "X",
			modelType: "TEXT_EMBEDDING",
			provider: "local",
			reason: "backend_unavailable",
		});
		expect(details).toEqual({
			code: "X",
			modelType: "TEXT_EMBEDDING",
			provider: "local",
			reason: "backend_unavailable",
		});
	});

	it("returns empty for non-objects", () => {
		expect(modelProviderFailureDetails(null)).toEqual({});
		expect(modelProviderFailureDetails("x")).toEqual({});
	});
});

describe("isExpectedLocalEmbeddingUnavailability", () => {
	it("matches the expected shape", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
			reason: "backend_unavailable",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(true);
	});

	it("accepts capability_unavailable", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
			reason: "capability_unavailable",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(true);
	});

	it("rejects foreign reasons", () => {
		const error = {
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			modelType: "TEXT_EMBEDDING",
			reason: "invalid_input",
		};
		expect(isExpectedLocalEmbeddingUnavailability(error)).toBe(false);
	});

	it("rejects wrong code or model type", () => {
		expect(
			isExpectedLocalEmbeddingUnavailability({
				code: "OTHER",
				modelType: "TEXT_EMBEDDING",
				reason: "backend_unavailable",
			}),
		).toBe(false);
		expect(
			isExpectedLocalEmbeddingUnavailability({
				code: "LOCAL_INFERENCE_UNAVAILABLE",
				modelType: "TEXT_GENERATION",
				reason: "backend_unavailable",
			}),
		).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isExpectedLocalEmbeddingUnavailability(null)).toBe(false);
		expect(isExpectedLocalEmbeddingUnavailability("x")).toBe(false);
	});
});
