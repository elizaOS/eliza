import { describe, expect, it } from "vitest";
import { inflectionTermKeys } from "../src/utils/inflection-term-keys";

describe("inflectionTermKeys -ing forms of -ie verbs", () => {
	it("maps dying, lying, tying, and vying to their -ie base forms", () => {
		for (const [base, ing] of [
			["die", "dying"],
			["lie", "lying"],
			["tie", "tying"],
			["vie", "vying"],
		] as const) {
			const storedKeys = new Set(inflectionTermKeys(ing));
			expect(storedKeys.has(base)).toBe(true);
			expect(inflectionTermKeys(base).some((key) => storedKeys.has(key))).toBe(
				true,
			);
		}
	});

	it("does not add the wrong -e word for -ie verbs", () => {
		expect(inflectionTermKeys("dying")).not.toContain("dye");
		expect(inflectionTermKeys("lying")).not.toContain("lye");
		expect(inflectionTermKeys("tying")).not.toContain("tye");
		expect(inflectionTermKeys("vying")).not.toContain("vye");
	});

	it("keeps the normal -ing stems for other verbs", () => {
		expect(inflectionTermKeys("trying")).toContain("try");
		expect(inflectionTermKeys("dyeing")).toContain("dye");
		expect(inflectionTermKeys("making")).toContain("make");
		expect(inflectionTermKeys("doing")).toContain("do");
		expect(inflectionTermKeys("waking")).toContain("wake");
	});
});
