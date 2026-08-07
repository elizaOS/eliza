/** Verifies the heavyweight local-skill providers remain opt-in. */

import { describe, expect, it } from "vitest";
import {
	skillInstructionsProvider,
	skillsSummaryProvider,
} from "./skills";

describe("Agent Skills providers", () => {
	it("opts heavyweight providers out of default registration", () => {
		expect(skillsSummaryProvider.registerByDefault).toBe(false);
		expect(skillInstructionsProvider.registerByDefault).toBe(false);
	});
});
