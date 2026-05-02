import { describe, expect, it } from "vitest";
import { flattenTextValues, toMultilineText } from "../../utils/text-normalize";

describe("text-normalize", () => {
	it("flattens nested mixed values into text fragments", () => {
		expect(
			flattenTextValues([
				" hello ",
				null,
				["world", 42],
				{
					topic: ["agents", "systems"],
					empty: "",
					nested: {
						mode: true,
					},
				},
			]),
		).toEqual([
			"hello",
			"world",
			"42",
			"topic: agents, systems",
			"nested: mode: true",
		]);
	});

	it("joins normalized fragments into multiline text", () => {
		expect(
			toMultilineText({
				bio: ["Helpful", "Concise"],
				style: "Direct",
			}),
		).toBe("bio: Helpful, Concise\nstyle: Direct");
	});
});
