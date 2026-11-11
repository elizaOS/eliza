import { describe, expect, it } from "vitest";
import {
	parseAndValidateCharacter,
	validateCharacter,
} from "../src/character-schema";

describe("character schema knowledge + documents", () => {
	it("keeps knowledge sources when documents are also declared", () => {
		const result = validateCharacter({
			name: "knowledge-and-documents",
			documents: [{ item: { case: "path", value: "/docs/a.md" } }],
			knowledge: [{ item: { case: "path", value: "/docs/b.md" } }],
		});

		expect(result.success).toBe(true);
		expect(result.data?.documents).toEqual([
			{ item: { case: "path", value: "/docs/a.md" } },
			{ item: { case: "path", value: "/docs/b.md" } },
		]);
	});

	it("still uses knowledge alone when documents are empty", () => {
		const result = validateCharacter({
			name: "knowledge-only",
			knowledge: [{ item: { case: "path", value: "/docs/b.md" } }],
		});

		expect(result.success).toBe(true);
		expect(result.data?.documents).toEqual([
			{ item: { case: "path", value: "/docs/b.md" } },
		]);
	});

	it("dedupes a source listed under both keys", () => {
		const result = validateCharacter({
			name: "knowledge-duplicate",
			documents: [{ item: { case: "path", value: "/docs/a.md" } }],
			knowledge: [{ item: { case: "path", value: "/docs/a.md" } }],
		});

		expect(result.success).toBe(true);
		expect(result.data?.documents).toEqual([
			{ item: { case: "path", value: "/docs/a.md" } },
		]);
	});

	it("merges both sources from a JSON character file", () => {
		const result = parseAndValidateCharacter(
			JSON.stringify({
				name: "knowledge-json",
				documents: [{ item: { case: "path", value: "/docs/a.md" } }],
				knowledge: [{ item: { case: "path", value: "/docs/b.md" } }],
			}),
		);

		expect(result.success).toBe(true);
		expect(result.data?.documents).toHaveLength(2);
	});
});
