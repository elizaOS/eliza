/**
 * Tests for action-tiering — tierActionResults.
 */
import { describe, expect, it } from "vitest";
import { tierActionResults } from "./action-tiering.ts";

describe("action-tiering", () => {
	it("places all parents in tierA", () => {
		const catalog = {
			parents: [
				{
					name: "alpha",
					normalizedName: "alpha",
					childNames: [],
					childNormalizedNames: [],
				},
				{
					name: "beta",
					normalizedName: "beta",
					childNames: [],
					childNormalizedNames: [],
				},
			],
		} as never;
		const result = tierActionResults({ catalog, results: [] });
		expect(result.tierAParents).toHaveLength(2);
		expect(result.tierBParents).toHaveLength(0);
		expect(result.tierCParents).toHaveLength(0);
	});

	it("exposes all parent names", () => {
		const catalog = {
			parents: [
				{
					name: "alpha",
					normalizedName: "alpha",
					childNames: [],
					childNormalizedNames: [],
				},
			],
		} as never;
		const result = tierActionResults({ catalog, results: [] });
		expect(result.exposedParentNames).toContain("alpha");
		expect(result.protocolActions).toContain("REPLY");
	});

	it("computes actionSurfaceHash deterministically", () => {
		const catalog = {
			parents: [
				{
					name: "alpha",
					normalizedName: "alpha",
					childNames: [],
					childNormalizedNames: [],
				},
			],
		} as never;
		const a = tierActionResults({ catalog, results: [] });
		const b = tierActionResults({ catalog, results: [] });
		expect(a.actionSurfaceHash).toBe(b.actionSurfaceHash);
	});

	it("handles empty catalog", () => {
		const catalog = { parents: [] } as never;
		const result = tierActionResults({ catalog, results: [] });
		expect(result.tierAParents).toHaveLength(0);
		expect(result.exposedParentNames).toHaveLength(0);
	});

	it("includes protocol actions by default", () => {
		const catalog = { parents: [] } as never;
		const result = tierActionResults({ catalog, results: [] });
		expect(result.protocolActions).toContain("IGNORE");
		expect(result.protocolActions).toContain("STOP");
	});
});
