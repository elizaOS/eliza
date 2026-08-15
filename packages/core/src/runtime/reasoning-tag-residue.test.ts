import { describe, expect, test } from "bun:test";
import { sanitizeOutboundText } from "./outbound-sanitize";

const MACHINE_SYNTAX_TAGS = [
	"think",
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
	"tool_call",
	"function_call",
] as const;

describe.each(MACHINE_SYNTAX_TAGS)("%s reasoning-tag residue", (tag) => {
	test("strips paired tags and their content", () => {
		expect(sanitizeOutboundText(`before<${tag}>private</${tag}>after`)).toBe(
			"beforeafter",
		);
	});

	test("strips an open-only tag through end of text", () => {
		expect(sanitizeOutboundText(`answer<${tag}>private residue`)).toBe(
			"answer",
		);
	});

	test("strips mixed-case tags", () => {
		const mixedCase = [...tag]
			.map((character, index) =>
				index % 2 === 0 ? character.toUpperCase() : character,
			)
			.join("");
		expect(
			sanitizeOutboundText(
				`before<${mixedCase}>private</${mixedCase}>after`,
			),
		).toBe("beforeafter");
	});

	test("strips whitespace variants", () => {
		expect(
			sanitizeOutboundText(`before< ${tag} >private</ ${tag} >after`),
		).toBe("beforeafter");
	});
});

test("preserves reasoning-tag examples in fenced code blocks", () => {
	const fenced = [
		"```xml",
		"<Think>document this</Think>",
		"< reasoning >also document this</ reasoning >",
		"```",
	].join("\n");
	expect(sanitizeOutboundText(`safe\n${fenced}\n<thought>private`)).toBe(
		`safe\n${fenced}`,
	);
});

test("keeps only the answer after a close-only reasoning tag", () => {
	expect(sanitizeOutboundText("private chain</ ThInKiNg >public answer")).toBe(
		"public answer",
	);
});
