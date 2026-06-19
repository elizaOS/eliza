import { describe, expect, it } from "vitest";
import { normalizeCharacterInput } from "./character";

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
});
