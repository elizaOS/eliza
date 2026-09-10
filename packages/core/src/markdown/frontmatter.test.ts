/**
 * Covers `parseFrontmatterBlock`: YAML frontmatter parsing with CRLF handling and
 * scalar/object→string coercion, line-parsing fallback for malformed YAML, empty
 * result for missing/unclosed delimiters, and a fast-check fuzz asserting it never
 * throws and yields only non-empty trimmed keys with string values.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFrontmatterBlock, parseFrontmatterDocument } from "./frontmatter";

describe("parseFrontmatterDocument", () => {
	it("distinguishes absent frontmatter and preserves the complete normalized body", () => {
		expect(parseFrontmatterDocument("# Heading\r\nbody")).toEqual({
			kind: "none",
			body: "# Heading\nbody",
		});
	});

	it("returns structured metadata and the complete document body", () => {
		expect(
			parseFrontmatterDocument(
				"---\ntitle: Example\ntags: [one, two]\n---\n# Heading\nbody\n",
			),
		).toEqual({
			kind: "parsed",
			frontmatter: { title: "Example", tags: ["one", "two"] },
			raw: "title: Example\ntags: [one, two]",
			body: "# Heading\nbody\n",
		});
	});

	it.each([
		["invalid-delimiter", "---\ntitle: missing closer"],
		["nul-byte", "---\ntitle: bad\u0000value\n---\nbody"],
		["invalid-root", "---\n- list root\n---\nbody"],
		["nest-bound", "---\nvalue: [one, [two]]\n---\nbody"],
	] as const)("reports malformed input as %s", (code, content) => {
		const result = parseFrontmatterDocument(content, { maxDepth: 1 });
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.code).toBe(code);
	});
});

describe("parseFrontmatterBlock", () => {
	it("parses CRLF frontmatter and coerces YAML scalar/object values to strings", () => {
		const parsed = parseFrontmatterBlock(
			[
				"---",
				"title: Test Doc",
				"draft: false",
				"count: 3",
				"nested:",
				"  owner: alice",
				"---",
				"# Body",
			].join("\r\n"),
		);

		expect(parsed).toEqual({
			title: "Test Doc",
			draft: "false",
			count: "3",
			nested: JSON.stringify({ owner: "alice" }),
		});
	});

	it("falls back to line parsing for malformed YAML blocks", () => {
		const parsed = parseFrontmatterBlock(
			[
				"---",
				"title: 'Recoverable Title'",
				"bad: [unterminated",
				"description:",
				"  first line",
				"  second line",
				"---",
				"body",
			].join("\n"),
		);

		expect(parsed).toMatchObject({
			title: "Recoverable Title",
			bad: "[unterminated",
			description: "first line\n  second line",
		});
	});

	it("returns empty metadata for missing or unclosed delimiters", () => {
		expect(parseFrontmatterBlock("title: nope\n---\nbody")).toEqual({});
		expect(parseFrontmatterBlock("---\ntitle: nope\nbody")).toEqual({});
	});

	it("fuzzes arbitrary markdown as non-throwing and string-only", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 2_000 }), (content) => {
				const parsed = parseFrontmatterBlock(content);

				for (const [key, value] of Object.entries(parsed)) {
					expect(key.trim()).toBe(key);
					expect(key.length).toBeGreaterThan(0);
					expect(typeof value).toBe("string");
				}
			}),
			{ numRuns: 500 },
		);
	});
});
