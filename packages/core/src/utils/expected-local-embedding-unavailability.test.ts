/**
 * Deterministic coverage for the structural local-embedding unavailability
 * predicate: only the documented code/reason pairs are expected; lookalikes
 * and unknown failures stay reportable.
 */
import { describe, expect, it } from "vitest";
import { ModelType } from "../types/model";
import { isExpectedLocalEmbeddingUnavailability } from "./expected-local-embedding-unavailability";

function unavailable(
	reason: string,
	code = "LOCAL_INFERENCE_UNAVAILABLE",
	modelType: string = ModelType.TEXT_EMBEDDING,
): { code: string; modelType: string; reason: string } {
	return { code, modelType, reason };
}

describe("isExpectedLocalEmbeddingUnavailability", () => {
	it.each(["backend_unavailable", "capability_unavailable"] as const)(
		"accepts LOCAL_INFERENCE_UNAVAILABLE with %s",
		(reason) => {
			expect(isExpectedLocalEmbeddingUnavailability(unavailable(reason))).toBe(
				true,
			);
		},
	);

	it.each(["invalid_input", "invalid_output", "other_reason", ""] as const)(
		"rejects LOCAL_INFERENCE_UNAVAILABLE with foreign reason %s",
		(reason) => {
			expect(isExpectedLocalEmbeddingUnavailability(unavailable(reason))).toBe(
				false,
			);
		},
	);

	it("rejects a lookalike code even with an expected reason", () => {
		expect(
			isExpectedLocalEmbeddingUnavailability(
				unavailable("backend_unavailable", "OTHER_UNAVAILABLE"),
			),
		).toBe(false);
	});

	it("rejects a missing or non-embedding model type", () => {
		expect(
			isExpectedLocalEmbeddingUnavailability({
				code: "LOCAL_INFERENCE_UNAVAILABLE",
				reason: "backend_unavailable",
			}),
		).toBe(false);
		expect(
			isExpectedLocalEmbeddingUnavailability(
				unavailable(
					"backend_unavailable",
					"LOCAL_INFERENCE_UNAVAILABLE",
					ModelType.TEXT_LARGE,
				),
			),
		).toBe(false);
	});

	it("rejects plain Errors, null, and non-objects", () => {
		expect(isExpectedLocalEmbeddingUnavailability(new Error("boom"))).toBe(
			false,
		);
		expect(isExpectedLocalEmbeddingUnavailability(null)).toBe(false);
		expect(isExpectedLocalEmbeddingUnavailability("backend_unavailable")).toBe(
			false,
		);
	});
});
