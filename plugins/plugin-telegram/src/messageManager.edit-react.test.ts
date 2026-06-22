import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

/**
 * Unit tests for the Telegram connector `edit_message` / `react_message`
 * capabilities (#8903). With edit available the orchestrator's compact progress
 * mode rewrites a single message across heartbeats instead of flooding the chat.
 */
function makeManager() {
	const editMessageText = vi.fn(async () => ({ message_id: 7 }));
	const setMessageReaction = vi.fn(async () => true);
	const bot = { telegram: { editMessageText, setMessageReaction } };
	const runtime = { agentId: "00000000-0000-0000-0000-0000000000aa" };
	const manager = new MessageManager(bot as never, runtime as never);
	return { manager, editMessageText, setMessageReaction };
}

describe("MessageManager.editMessage (#8903)", () => {
	let env: ReturnType<typeof makeManager>;
	beforeEach(() => {
		env = makeManager();
	});

	it("edits in place as MarkdownV2", async () => {
		await env.manager.editMessage(123, 7, "**bold** progress");
		expect(env.editMessageText).toHaveBeenCalledTimes(1);
		const [chatId, messageId, inlineId, text, opts] =
			env.editMessageText.mock.calls[0];
		expect(chatId).toBe(123);
		expect(messageId).toBe(7);
		expect(inlineId).toBeUndefined();
		expect(typeof text).toBe("string");
		expect(opts).toEqual({ parse_mode: "MarkdownV2" });
	});

	it("falls back to plain text when MarkdownV2 is rejected (400 parse error)", async () => {
		const err = {
			response: {
				error_code: 400,
				description: "Bad Request: can't parse entities",
			},
		};
		env.editMessageText
			.mockRejectedValueOnce(err)
			.mockResolvedValueOnce({ message_id: 7 } as never);

		await env.manager.editMessage(123, 7, "**bold** progress");

		expect(env.editMessageText).toHaveBeenCalledTimes(2);
		// The retry carries no parse_mode (plain text).
		const retryOpts = env.editMessageText.mock.calls[1][4];
		expect(retryOpts).toBeUndefined();
	});
});

describe("MessageManager.addReaction (#8903)", () => {
	let env: ReturnType<typeof makeManager>;
	beforeEach(() => {
		env = makeManager();
	});

	it("sets a single emoji reaction", async () => {
		await env.manager.addReaction(123, 7, "👍");
		expect(env.setMessageReaction).toHaveBeenCalledWith(123, 7, [
			{ type: "emoji", emoji: "👍" },
		]);
	});

	it("clears reactions when no emoji is given", async () => {
		await env.manager.addReaction(123, 7, undefined);
		expect(env.setMessageReaction).toHaveBeenCalledWith(123, 7, []);
	});
});
