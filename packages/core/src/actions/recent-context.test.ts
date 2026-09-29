import { expect, it } from "vitest";
import type { State } from "../types/state";
import {
	recentConversationTexts,
	recentConversationTextsFromState,
} from "./recent-context";

it("includes a rendered history projection only once when composed state already embeds it", () => {
	const history =
		"# Conversation Messages (2 retained)\nuser: again\nuser: again";
	const text = `# UI Context\nview: chat\n# People\nowner\n${history}\n# Received Message\nremind me`;
	const state = {
		values: { recentMessages: history },
		text,
		data: {
			providers: {
				RECENT_MESSAGES: {
					data: {
						recentMessages: [
							{ content: { text: "again" } },
							{ content: { text: "again" } },
						],
					},
				},
			},
		},
	} as unknown as State;
	expect(recentConversationTextsFromState(state)).toEqual([
		text,
		"again",
		"again",
	]);
});
it("retains differently rendered or unavailable composed history without normalizing whitespace", () => {
	const state = {
		values: { recentMessages: "user: two  spaces\n" },
		text: "# UI\nuser: two spaces\n",
	} as unknown as State;
	expect(recentConversationTextsFromState(state)).toEqual([
		"user: two  spaces\n",
		"# UI\nuser: two spaces\n",
	]);
	expect(
		recentConversationTextsFromState({
			values: { recentMessages: "history" },
		} as unknown as State),
	).toEqual(["history"]);
});
it("does not collapse a partial overlap", () => {
	const state = {
		values: { recentMessages: "user: one\nuser: two" },
		text: "user: two\nuser: three",
	} as unknown as State;
	expect(recentConversationTextsFromState(state)).toEqual([
		"user: one\nuser: two",
		"user: two\nuser: three",
	]);
});

it("preserves short plain state text even if it appears in unrelated composed prose", () => {
	expect(
		recentConversationTextsFromState({
			values: { recentMessages: "yes" },
			text: "The owner said yes.",
		} as unknown as State),
	).toEqual(["yes", "The owner said yes."]);
});
it("keeps DB and provider occurrences unchanged alongside the single rendered block", async () => {
	const history = "# Conversation Messages (1 retained)\nuser: repeat";
	const text = `# UI Context\nchat\n${history}\n# Received Message\nrepeat`;
	const result = await recentConversationTexts({
		runtime: {
			getMemories: async () => [
				{ content: { text: "repeat" } },
				{ content: { text: "repeat" } },
			],
		} as never,
		message: { roomId: "room" } as never,
		state: {
			values: { recentMessages: history },
			text,
			data: {
				providers: {
					RECENT_MESSAGES: {
						data: { recentMessages: [{ content: { text: "repeat" } }] },
					},
				},
			},
		} as unknown as State,
	});
	expect(result).toEqual(["repeat", "repeat", text, "repeat"]);
});
