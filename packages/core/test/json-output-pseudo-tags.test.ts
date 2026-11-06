import { describe, expect, it } from "vitest";
import { parsePseudoTagToolInvocations } from "../src/runtime/json-output";

describe("parsePseudoTagToolInvocations argument bodies", () => {
	it("still reads a bare JSON object", () => {
		expect(
			parsePseudoTagToolInvocations(
				'<NOTES_CREATE>{"title":"Plan","body":"Draft"}</NOTES_CREATE>',
			),
		).toEqual([
			{
				name: "NOTES_CREATE",
				params: { title: "Plan", body: "Draft" },
			},
		]);
	});

	it("reads a JSON object inside a Markdown fence", () => {
		expect(
			parsePseudoTagToolInvocations(
				[
					"<NOTES_CREATE>",
					"```json",
					'{"title":"Plan {draft}","metadata":{"priority":1}}',
					"```",
					"</NOTES_CREATE>",
				].join("\n"),
			),
		).toEqual([
			{
				name: "NOTES_CREATE",
				params: {
					title: "Plan {draft}",
					metadata: { priority: 1 },
				},
			},
		]);
	});

	it("keeps non-object fenced bodies unrecoverable", () => {
		expect(
			parsePseudoTagToolInvocations(
				["<NOTES_CREATE>", "```json", "[1,2]", "```", "</NOTES_CREATE>"].join(
					"\n",
				),
			),
		).toEqual([]);
	});

	it("preserves document order across fenced and bare calls", () => {
		expect(
			parsePseudoTagToolInvocations(
				[
					"<NOTES_CREATE>",
					"```json",
					'{"title":"First"}',
					"```",
					"</NOTES_CREATE>",
					'<NOTES_UPDATE>{"title":"Second"}</NOTES_UPDATE>',
				].join("\n"),
			),
		).toEqual([
			{ name: "NOTES_CREATE", params: { title: "First" } },
			{ name: "NOTES_UPDATE", params: { title: "Second" } },
		]);
	});

	it("does not span two same-name tags with different envelopes", () => {
		expect(
			parsePseudoTagToolInvocations(
				[
					"<NOTES_CREATE>",
					"```json",
					'{"title":"First"}',
					"```",
					"</NOTES_CREATE>",
					'<NOTES_CREATE>{"title":"Second"}</NOTES_CREATE>',
				].join("\n"),
			),
		).toEqual([
			{ name: "NOTES_CREATE", params: { title: "First" } },
			{ name: "NOTES_CREATE", params: { title: "Second" } },
		]);
	});
});
