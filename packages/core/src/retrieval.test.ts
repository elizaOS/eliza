/** Tied search hits must follow UUID order, matching the SQL id tie-break. */
import { expect, it } from "vitest";
import { rankMessageSearch } from "./retrieval.ts";

const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const upperId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

it("orders equal-rank same-millisecond hits by UUID, not letter case", () => {
	const ranked = rankMessageSearch(
		[
			{
				id: upperId,
				createdAt: 1_700_000_000_000,
				content: { text: "budget" },
			},
			{
				id: lowerId,
				createdAt: 1_700_000_000_000,
				content: { text: "budget" },
			},
		],
		"budget",
	);
	expect(ranked.map((hit) => hit.item.id)).toEqual([lowerId, upperId]);
});
