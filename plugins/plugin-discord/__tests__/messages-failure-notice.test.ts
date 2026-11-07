/**
 * The "reply unavailable" notice after a failed turn goes only to a sender who
 * asked: a DM or a guild message addressed to the bot. A guild message the
 * agent chose to answer on its own fails silently. Drives the real
 * MessageManager with Discord network objects stubbed.
 */
import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	BOT_USER_ID,
	makeMessageManagerHarness,
} from "../test/helpers/message-manager-harness.ts";

/** The agent took the turn, then generation failed before any reply. */
function failedTurn(turns: string[]) {
	return async (message: Memory) => {
		turns.push(message.id as string);
		throw Object.assign(new Error("reply grounding failed"), {
			code: "REPLY_GROUNDING_FAILED",
		});
	};
}

describe("Discord failure notice after a failed turn", () => {
	it("stays silent in a guild channel when the message did not address the bot", async () => {
		const turns: string[] = [];
		const h = makeMessageManagerHarness({
			inboundId: "666000000000000010",
			content: "big airdrop live now, claim at example.com",
			handleMessage: failedTurn(turns),
			dm: false,
		});
		await h.run();
		// The turn reached generation and failed there.
		expect(turns).toHaveLength(1);
		expect(h.sends).toEqual([]);
	});

	it("sends the notice in a guild channel when the message @mentions the bot", async () => {
		const turns: string[] = [];
		const h = makeMessageManagerHarness({
			inboundId: "666000000000000011",
			content: `<@${BOT_USER_ID}> what's the status?`,
			handleMessage: failedTurn(turns),
			dm: false,
			mentionsBot: true,
		});
		await h.run();
		expect(turns).toHaveLength(1);
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]).not.toBe("");
	});

	it("sends the notice in a DM", async () => {
		const turns: string[] = [];
		const h = makeMessageManagerHarness({
			inboundId: "666000000000000012",
			content: "what's the status?",
			handleMessage: failedTurn(turns),
		});
		await h.run();
		expect(turns).toHaveLength(1);
		expect(h.sends).toHaveLength(1);
	});
});
