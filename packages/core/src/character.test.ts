/**
 * Covers normalizeCharacterInput's document/knowledge merge and asserts
 * character.ts owns no provider-plugin auto-enable rules (no `buildCharacterPlugins`
 * export, no hardcoded `@elizaos/plugin-` names). Pure in-process assertions, no
 * runtime or model.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as characterModule from "./character";
import { normalizeCharacterInput } from "./character";
import {
	documentDirectorySchema,
	validateCharacter,
} from "./schemas/character";

describe("normalizeCharacterInput", () => {
	it("imports legacy character knowledge alongside documents", () => {
		const normalized = normalizeCharacterInput({
			name: "test",
			bio: [],
			documents: ["./documents/current.md"],
			knowledge: ["./knowledge/legacy.md"],
		});

		expect(
			normalized.documents.map((item) =>
				item.item.case === "path" ? item.item.value : null,
			),
		).toEqual(["./documents/current.md", "./knowledge/legacy.md"]);
	});

	it("maps directory shorthand to path in document directory value", () => {
		const normalized = normalizeCharacterInput({
			name: "test",
			bio: [],
			documents: [{ directory: "./docs", shared: true }],
		});

		expect(normalized.documents).toEqual([
			{ item: { case: "directory", value: { path: "./docs", shared: true } } },
		]);

		// The normalized directory value must satisfy the Zod documentDirectorySchema
		// (requires `path`, not `directory`). The pre-fix shape { directory: "./docs" }
		// would fail this parse.
		const dirValue = (normalized.documents[0] as { item: { value: unknown } })
			.item.value;
		expect(documentDirectorySchema.safeParse(dirValue).success).toBe(true);
		expect(
			documentDirectorySchema.safeParse({ directory: "./docs", shared: true })
				.success,
		).toBe(false);

		// Full character validation must also pass with the normalized document
		expect(validateCharacter(normalized).success).toBe(true);
	});

	it("does not own provider plugin auto-enable rules", () => {
		expect("buildCharacterPlugins" in characterModule).toBe(false);

		const source = readFileSync(
			resolve(import.meta.dirname, "character.ts"),
			"utf8",
		);
		expect(source).not.toContain("@elizaos/plugin-");
	});
});
