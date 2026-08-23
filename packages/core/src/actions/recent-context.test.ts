import { describe, expect, it } from "vitest";
import { recentConversationTextsFromState } from "./recent-context";

describe("recentConversationTextsFromState", () => {
	it("preserves every occurrence including identical wording (#24858)", () => {
		// Two distinct turns with identical wording must remain two entries.
		const state = {
			values: { recentMessages: "User: repeat this\nUser: repeat this" },
		} as never;

		const result = recentConversationTextsFromState(state);
		expect(result).toEqual(["repeat this", "repeat this"]);
	});

	it("preserves identical wording across mixed sources (#24858)", () => {
		// Identical text arriving via state.values.recentMessages and via a
		// memory row must both be preserved, not collapsed.
		// The memory row must sit on the canonical provider path that
		// `getRecentMessagesData` reads; no other location is populated.
		const state = {
			values: { recentMessages: "repeat this" },
			data: {
				providers: {
					RECENT_MESSAGES: {
						data: {
							recentMessages: [
								{
									id: "m1",
									content: { text: "repeat this" },
								},
							],
						},
					},
				},
			},
		} as never;

		const result = recentConversationTextsFromState(state);
		expect(result).toEqual(["repeat this", "repeat this"]);
	});

	it("returns an empty array when state is undefined", () => {
		expect(recentConversationTextsFromState(undefined)).toEqual([]);
	});

	it("strips speaker prefixes and drops empty lines", () => {
		const state = {
			values: { recentMessages: "Alice: Hello\n\nBob: World" },
		} as never;
		expect(recentConversationTextsFromState(state)).toEqual(["Hello", "World"]);
	});
});
