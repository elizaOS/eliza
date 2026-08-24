import { describe, expect, it } from "vitest";
import { getRecentMessagesData } from "./recent-messages-state.js";

describe("getRecentMessagesData", () => {
	it("returns array when path exists", () => {
		const state = {
			data: {
				providers: {
					RECENT_MESSAGES: { data: { recentMessages: [{ id: "1" }] } },
				},
			},
		} as unknown as import("./types/index.js").State;
		expect(getRecentMessagesData(state)).toHaveLength(1);
	});

	it("returns empty for undefined or missing path", () => {
		expect(getRecentMessagesData(undefined)).toEqual([]);
		expect(getRecentMessagesData({} as never)).toEqual([]);
		expect(getRecentMessagesData({ data: { providers: {} } } as never)).toEqual(
			[],
		);
	});

	it("returns empty when not an array", () => {
		const state = {
			data: {
				providers: { RECENT_MESSAGES: { data: { recentMessages: "bad" } } },
			},
		} as unknown as import("./types/index.js").State;
		expect(getRecentMessagesData(state)).toEqual([]);
	});
});
