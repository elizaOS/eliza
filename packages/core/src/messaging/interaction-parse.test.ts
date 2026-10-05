import { describe, expect, it } from "vitest";
import type { ChoiceInteraction } from "../types/interactions";
import {
	findInteractionRegions,
	parseInteractionBlocks,
} from "./interaction-parse";

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

describe("scanRawInteractionRegions fenced code", () => {
	it("preserves interaction grammar inside fenced code blocks", () => {
		const text = [
			"To offer a choice, emit this marker:",
			"",
			"```",
			"[CHOICE:approval]",
			"yes=Approve",
			"no=Deny",
			"[/CHOICE]",
			"```",
			"",
			"That's the whole syntax.",
		].join("\n");
		const parsed = parseInteractionBlocks(text);

		expect(parsed.blocks).toEqual([]);
		expect(parsed.cleanedText).toBe(text);
	});

	it("keeps fenced same-kind openers from displacing a real block", () => {
		const regions = findInteractionRegions(
			[
				"[CHOICE:real]",
				"a=Alpha",
				"```",
				"[CHOICE:one]",
				"[CHOICE:two]",
				"```",
				"[/CHOICE]",
			].join("\n"),
		);
		expect(regions).toHaveLength(1);
		expect((regions[0].block as ChoiceInteraction).scope).toBe("real");
	});
});
