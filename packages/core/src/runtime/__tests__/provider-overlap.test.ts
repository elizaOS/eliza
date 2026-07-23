/** Validates persisted provider timing overlap math against exact epoch intervals. */
import { describe, expect, it } from "vitest";
import { calculateProviderOverlaps } from "../../runtime";

describe("calculateProviderOverlaps", () => {
	it("records exact pairwise overlap and leaves serial providers empty", () => {
		const overlaps = calculateProviderOverlaps([
			{ providerName: "A", providerStartedAt: 1_000, providerEndedAt: 1_100 },
			{ providerName: "B", providerStartedAt: 1_040, providerEndedAt: 1_160 },
			{ providerName: "C", providerStartedAt: 1_200, providerEndedAt: 1_220 },
		]);

		expect(overlaps).toEqual([
			[{ providerName: "B", overlapMs: 60 }],
			[{ providerName: "A", overlapMs: 60 }],
			[],
		]);
	});
});
