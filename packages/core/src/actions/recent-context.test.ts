/**
 * Verifies lossless recent-conversation extraction from canonical provider
 * state and durable room memories, including repeated text across sources.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../types";
import {
	recentConversationTexts,
	recentConversationTextsFromState,
} from "./recent-context";

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

	it("preserves identical turns across durable storage and canonical provider state", async () => {
		const state = {
			values: { recentMessages: "User: repeat this" },
			data: {
				providers: {
					RECENT_MESSAGES: {
						data: {
							recentMessages: [
								{
									id: "provider-turn",
									content: { text: "User: repeat this" },
								},
							],
						},
					},
				},
			},
		} as never;
		const runtime = {
			getMemories: async () => [
				{ id: "stored-turn", content: { text: "User: repeat this" } },
			],
			reportError: () => undefined,
		} as unknown as IAgentRuntime;

		const result = await recentConversationTexts({
			runtime,
			message: { roomId: "room-1" } as never,
			state,
		});

		expect(result).toEqual(["repeat this", "repeat this", "repeat this"]);
	});
});
