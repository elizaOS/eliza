import { describe, expect, it } from "vitest";
import type { Memory } from "../types/memory";
import { getUserMessageText } from "./message-text";

describe("getUserMessageText", () => {
	it("prefers connector-provided current-turn text over rendered envelopes", () => {
		const message = {
			content: {
				text: '[Discord #general] @ada: Can you tell me what elizaOS is?\n(in reply to @agent: "The Bitcoin price is ...")',
				currentMessageText: "Can you tell me what elizaOS is?",
			},
		} as unknown as Memory;

		expect(getUserMessageText(message)).toBe(
			"Can you tell me what elizaOS is?",
		);
	});
});
