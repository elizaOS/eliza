import { describe, expect, it } from "vitest";
import { getRecentMessagesData } from "../recent-messages-state.ts";

describe("getRecentMessagesData", () => {
	it("reads the canonical provider path", () => {
		const state = {
			data: {
				providers: {
					RECENT_MESSAGES: { data: { recentMessages: [{ id: "m1" }] } },
				},
			},
		} as never;
		expect(getRecentMessagesData(state)).toEqual([{ id: "m1" }]);
	});

	it("returns empty for missing or malformed paths", () => {
		expect(getRecentMessagesData(undefined)).toEqual([]);
		expect(getRecentMessagesData({} as never)).toEqual([]);
		expect(
			getRecentMessagesData({
				data: { providers: { RECENT_MESSAGES: { data: {} } } },
			} as never),
		).toEqual([]);
	});
});
