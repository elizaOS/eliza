import { describe, expect, test } from "vitest";
import { resolveDefaultOutputFormat } from "../runtime";

describe("resolveDefaultOutputFormat", () => {
	test.each([
		["xml", "XML"],
		["XML", "XML"],
		["Xml", "XML"],
		["  xml  ", "XML"],
		["json", "JSON"],
		["JSON", "JSON"],
		["toon", "TOON"],
		["TOON", "TOON"],
	] as const)("%s → %s", (input, expected) => {
		expect(resolveDefaultOutputFormat(input)).toBe(expected);
	});

	test.each([undefined, null, "", "yaml", "markdown", 42, {}])(
		"unrecognized %p → TOON",
		(input) => {
			expect(resolveDefaultOutputFormat(input)).toBe("TOON");
		},
	);
});
