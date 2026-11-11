import { describe, expect, it } from "vitest";
import { resolveEnvAlias } from "../src/utils/env";

describe("resolveEnvAlias", () => {
	it("returns the trimmed direct value", () => {
		expect(resolveEnvAlias("K", [], { K: "  abc  " })).toBe("abc");
		expect(resolveEnvAlias("K", [], { K: "abc" })).toBe("abc");
	});

	it("returns the trimmed alias value", () => {
		expect(
			resolveEnvAlias("K", [["K", "ALIAS_K"]], { ALIAS_K: "  xyz " }),
		).toBe("xyz");
		expect(
			resolveEnvAlias("ALIAS_K", [["K", "ALIAS_K"]], { K: "  xyz " }),
		).toBe("xyz");
	});

	it("prefers the direct value over the alias", () => {
		expect(
			resolveEnvAlias("K", [["K", "ALIAS_K"]], {
				K: " direct ",
				ALIAS_K: " alias ",
			}),
		).toBe("direct");
	});

	it("treats whitespace-only values as unset", () => {
		expect(resolveEnvAlias("K", [], { K: "   " })).toBeUndefined();
		expect(
			resolveEnvAlias("K", [["K", "ALIAS_K"]], {
				K: "   ",
				ALIAS_K: "  ",
			}),
		).toBeUndefined();
		expect(resolveEnvAlias("K", [], null)).toBeUndefined();
		expect(resolveEnvAlias("K", [], {})).toBeUndefined();
	});
});
