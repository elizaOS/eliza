import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFrontmatterBlock } from "./frontmatter";

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
