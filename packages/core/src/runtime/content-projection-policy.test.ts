/**
 * Verifies the opt-in progressive-content rollout setting and the redacted,
 * count-only diagnostics attached to model-call metadata.
 */

import { describe, expect, it } from "vitest";
import {
	buildContentProjectionDiagnostics,
	isProgressiveContentProjectionEnabled,
	PROGRESSIVE_CONTENT_PROJECTION_SETTING,
} from "./content-projection-policy";

describe("progressive content projection policy", () => {
	it("defaults safely off and accepts repository-standard boolean values", () => {
		expect(isProgressiveContentProjectionEnabled(undefined)).toBe(false);
		expect(
			isProgressiveContentProjectionEnabled({ getSetting: () => undefined }),
		).toBe(false);
		expect(
			isProgressiveContentProjectionEnabled({ getSetting: () => "invalid" }),
		).toBe(false);
		expect(
			isProgressiveContentProjectionEnabled({ getSetting: () => "true" }),
		).toBe(true);
		expect(
			isProgressiveContentProjectionEnabled({ getSetting: () => "off" }),
		).toBe(false);
		expect(
			isProgressiveContentProjectionEnabled({ getSetting: () => true }),
		).toBe(true);
	});

	it("reads only the named rollout setting", () => {
		const seen: string[] = [];
		isProgressiveContentProjectionEnabled({
			getSetting: (key) => {
				seen.push(key);
				return false;
			},
		});
		expect(seen).toEqual([PROGRESSIVE_CONTENT_PROJECTION_SETTING]);
	});

	it("emits numeric projection metadata without content or locators", () => {
		const diagnostics = buildContentProjectionDiagnostics({
			enabled: true,
			baselineBudget: {
				estimatedInputTokens: 2_000,
				contextWindowTokens: 10_000,
				reserveTokens: 1_000,
				compactionThresholdTokens: 9_000,
				shouldCompact: false,
				resolvedModelKey: null,
			},
			projectionBudget: {
				perResultTokens: 3_000,
				aggregateTokens: 6_000,
			},
			stats: {
				resultCount: 2,
				pagesIncluded: 1,
				pagesOmitted: 1,
				omissionReasons: { "model-input-budget": 1 },
			},
		});
		expect(diagnostics).toEqual({
			enabled: true,
			resultCount: 2,
			baselineEstimatedTokens: 2_000,
			remainingEstimatedTokens: 7_000,
			perResultEstimatedTokens: 3_000,
			aggregateEstimatedTokens: 6_000,
			pagesIncluded: 1,
			pagesOmitted: 1,
			omissionReasons: { "model-input-budget": 1 },
		});
		const serialized = JSON.stringify(diagnostics);
		expect(serialized).not.toMatch(
			/secret body|\/Users\/|file_opaque|sha256/iu,
		);
	});
});
