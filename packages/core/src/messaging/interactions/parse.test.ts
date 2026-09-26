import { describe, expect, it } from "vitest";
import type { ChoiceInteraction } from "../../types/interactions";
import { findInteractionRegions, parseInteractionBlocks } from "./parse";

describe("scanRawInteractionRegions opener pairing", () => {
	it("does not pair an unterminated choice with a later choice closer", () => {
		const parsed = parseInteractionBlocks(
			[
				"Pick one:",
				"[CHOICE:first]",
				"a=Alpha",
				"",
				"Sorry, ignore that. Here is the real question.",
				"",
				"[CHOICE:second]",
				"b=Beta",
				"[/CHOICE]",
			].join("\n"),
		);

		expect(parsed.blocks).toMatchObject([
			{
				kind: "choice",
				scope: "second",
				options: [{ value: "b", label: "Beta" }],
			},
		]);
		expect(parsed.cleanedText).toContain("[CHOICE:first]\na=Alpha");
		expect(parsed.cleanedText).toContain(
			"Sorry, ignore that. Here is the real question.",
		);
	});

	it("keeps the active opener when a later same-kind opener is malformed", () => {
		for (const malformed of ["[CHOICE]", "[CHOICE:]", "[CHOICE:!!]"]) {
			const regions = findInteractionRegions(
				`[CHOICE:a]\nx=1\n${malformed}\ny=2\n[/CHOICE]`,
			);
			expect(regions).toHaveLength(1);
			expect((regions[0].block as ChoiceInteraction).scope).toBe("a");
		}
	});

	it("does not let a different-kind opener replace an active choice", () => {
		const regions = findInteractionRegions(
			"[CHOICE:a]\nx=1\n[/CHOICE]\n[TASK:a1b2c3d4]Fix login[/TASK]",
		);
		expect(regions.map((region) => region.block.kind)).toEqual([
			"choice",
			"task",
		]);
	});
});
