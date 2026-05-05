import { describe, expect, it } from "vitest";
import { basicActions } from "../features/basic-capabilities/index.ts";

describe("basicActions", () => {
	it("does not expose COMPACT_SESSION as a selectable action", () => {
		expect(basicActions.map((action) => action.name)).not.toContain(
			"COMPACT_SESSION",
		);
	});
});
