import { describe, expect, it } from "vitest";
import { diffContextSegments } from "../context-diff";

describe("context diff helpers", () => {
	it("classifies unchanged, changed, added, removed, and moved segments", () => {
		const diff = diffContextSegments(
			[
				{ id: "same", content: "same", stable: true, tokenCount: 2 },
				{ id: "changed", content: "before", stable: false, tokenCount: 3 },
				{ id: "removed", content: "gone", stable: false, tokenCount: 5 },
				{ id: "moved", content: "move me", stable: true, tokenCount: 7 },
			],
			[
				{ id: "same", content: "same", stable: true, tokenCount: 2 },
				{ id: "moved", content: "move me", stable: true, tokenCount: 7 },
				{ id: "changed", content: "after now", stable: false, tokenCount: 4 },
				{ id: "added", content: "new", stable: false, tokenCount: 6 },
			],
		);

		expect(diff.changes.map((change) => change.type)).toEqual([
			"unchanged",
			"moved",
			"changed",
			"added",
			"removed",
		]);
		expect(diff.summary).toEqual({
			unchanged: 1,
			moved: 1,
			changed: 1,
			added: 1,
			removed: 1,
			tokenDelta: 2,
		});
	});
});
