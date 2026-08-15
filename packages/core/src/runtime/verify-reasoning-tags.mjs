import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sanitizeOutboundText } from "./outbound-sanitize.ts";

const tags = [
	"think",
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
	"tool_call",
	"function_call",
];

for (const tag of tags) {
	assert.equal(
		sanitizeOutboundText(`before<${tag}>private</${tag}>after`),
		"beforeafter",
		`${tag}: paired`,
	);
	assert.equal(
		sanitizeOutboundText(`answer<${tag}>private residue`),
		"answer",
		`${tag}: open-only`,
	);
	const mixedCase = [...tag]
		.map((character, index) =>
			index % 2 === 0 ? character.toUpperCase() : character,
		)
		.join("");
	assert.equal(
		sanitizeOutboundText(
			`before<${mixedCase}>private</${mixedCase}>after`,
		),
		"beforeafter",
		`${tag}: mixed case`,
	);
	assert.equal(
		sanitizeOutboundText(`before< ${tag} >private</ ${tag} >after`),
		"beforeafter",
		`${tag}: whitespace`,
	);
}

const fenced = "```xml\n<Think>visible example</Think>\n```";
assert.equal(
	sanitizeOutboundText(`safe\n${fenced}\n<reflection>private`),
	`safe\n${fenced}`,
	"fenced code preservation",
);
assert.equal(
	sanitizeOutboundText("private chain</ ThInKiNg >public answer"),
	"public answer",
	"close-only residue",
);

const planner = await readFile(new URL("./planner-loop.ts", import.meta.url), "utf8");
const evaluator = await readFile(new URL("./evaluator.ts", import.meta.url), "utf8");
assert.match(planner, /return sanitizeOutboundText\(text\);/);
assert.match(evaluator, /let cleaned = sanitizeOutboundText\(text\);/);

console.log(`Verified ${tags.length} machine-syntax tag families and both final-message call sites.`);
