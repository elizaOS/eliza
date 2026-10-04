/**
 * Topic search slices equal-score rooms. UUID order is case-insensitive, so an
 * uppercase id must not jump ahead of a lower one on a one-row page.
 */
import { describe, expect, it } from "vitest";
import { matchTopicRooms } from "./channel-topics";

const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPPER = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

describe("topic search UUID ties", () => {
	it("keeps the lower UUID when two rooms match the same number of tokens", () => {
		const page = matchTopicRooms(
			{
				[UPPER]: ["solana"],
				[LOWER]: ["solana"],
			},
			"solana",
			1,
		);

		expect(page.map((hit) => hit.roomId)).toEqual([LOWER]);
	});
});
