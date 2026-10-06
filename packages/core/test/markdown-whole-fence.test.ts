import { expect, it } from "vitest";
import { unwrapWholeCodeFence } from "../src/markdown/code.ts";

it("unwraps long JSON fences only with a complete matching closer", () => {
	expect(unwrapWholeCodeFence('````json\n{"text":"```"}\n````', ["json"])).toBe(
		'{"text":"```"}',
	);
	expect(unwrapWholeCodeFence("````json\n{}\n`````", ["json"])).toBe("{}");
	expect(unwrapWholeCodeFence("````json\n{}\n```", ["json"])).toBeNull();
	expect(unwrapWholeCodeFence("````json\n{}\nNOPE", ["json"])).toBeNull();
	expect(unwrapWholeCodeFence("```json\n{}\nxxx", ["json"])).toBeNull();
	expect(unwrapWholeCodeFence("```true```", ["json"])).toBe("true");
});
