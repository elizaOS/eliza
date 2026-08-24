/**
 * Unit tests for experience generated specs: validates coreActionsSpec structure and action documentation.
 */
import { describe, expect, it } from "vitest";
import { coreActionsSpec } from "./specs.ts";

describe("experience generated specs", () => {
	it("exports coreActionsSpec with version and actions list", () => {
		expect(coreActionsSpec.version).toBe("1.0.0");
		expect(Array.isArray(coreActionsSpec.actions)).toBe(true);
		expect(coreActionsSpec.actions.length).toBeGreaterThan(0);
	});

	it("includes RECORD_EXPERIENCE action specification with similes and examples", () => {
		const recordAction = coreActionsSpec.actions.find(
			(a) => a.name === "RECORD_EXPERIENCE",
		);
		expect(recordAction).toBeDefined();
		expect(recordAction?.similes).toContain("REMEMBER");
		expect(recordAction?.similes).toContain("LEARN");
		expect(Array.isArray(recordAction?.examples)).toBe(true);
	});
});
