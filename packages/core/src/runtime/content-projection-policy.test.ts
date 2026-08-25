/**
 * Verifies the deprecated projection API remains source-compatible while no
 * setting or stale caller metadata can restore model-facing omission.
 */

import { describe, expect, it } from "vitest";
import {
	buildContentProjectionDiagnostics,
	isProgressiveContentProjectionEnabled,
} from "./content-projection-policy";
import { buildContentProjectionBudget } from "./model-input-budget";

describe("disabled content projection compatibility", () => {
	it("cannot be enabled through the retired setting", () => {
		expect(
			isProgressiveContentProjectionEnabled({ getSetting: () => "true" }),
		).toBe(false);
	});

	it("reports complete inclusion and zero omission budgets", () => {
		expect(
			buildContentProjectionDiagnostics({
				enabled: true,
				baselineBudget: {
					estimatedInputTokens: 20,
					contextWindowTokens: 100,
					reserveTokens: 10,
					dispatchThresholdTokens: 90,
					shouldReject: false,
					estimationMode: "heuristic",
					resolvedModelKey: null,
				},
				projectionBudget: { perResultTokens: 2, aggregateTokens: 4 },
				stats: {
					resultCount: 3,
					pagesIncluded: 3,
					pagesOmitted: 2,
					omissionReasons: { legacy: 2 },
				},
			}),
		).toMatchObject({
			enabled: false,
			remainingEstimatedTokens: 70,
			perResultEstimatedTokens: 0,
			aggregateEstimatedTokens: 0,
			pagesIncluded: 3,
			pagesOmitted: 0,
			omissionReasons: {},
		});
	});

	it("turns legacy projection calls into a typed explicit failure", () => {
		expect(() =>
			buildContentProjectionBudget({
				budget: {
					estimatedInputTokens: 1,
					contextWindowTokens: 100,
					reserveTokens: 10,
					dispatchThresholdTokens: 90,
					shouldReject: false,
					compactionThresholdTokens: 90,
					shouldCompact: false,
					estimationMode: "heuristic",
					resolvedModelKey: null,
				},
				resultCount: 1,
			}),
		).toThrowError(
			expect.objectContaining({ code: "CONTENT_PROJECTION_RETIRED" }),
		);
	});
});
