import type { Message as DiscordMessage, TextChannel } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftStreamController } from "../draft-stream";

type DiscordSendPayload = {
	content?: string;
	reply?: { messageReference: string };
};

type FakeDiscordMessage = DiscordMessage & {
	edit: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
};

function fakeChannel(): TextChannel & { _messages: FakeDiscordMessage[] } {
	let nextId = 0;
	const messages: FakeDiscordMessage[] = [];
	const channel = {
		send: vi.fn(async (payload: DiscordSendPayload) => {
			const message = {
				id: `message-${++nextId}`,
				content: payload.content ?? "",
				edit: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			} as unknown as FakeDiscordMessage;
			messages.push(message);
			return message;
		}),
		_messages: messages,
	};

	return channel as unknown as TextChannel & {
		_messages: FakeDiscordMessage[];
	};
}

describe("Discord draft stream", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not create an editable placeholder when started", async () => {
		const channel = fakeChannel();
		const draftStream = createDraftStreamController();

		const startedMessage = await draftStream.start(channel, "source-message");

		expect(startedMessage).toBeNull();
		expect(channel.send).not.toHaveBeenCalled();
		expect(channel._messages).toHaveLength(0);
	});

	it("finalizes by sending a new reply instead of editing a draft", async () => {
		const channel = fakeChannel();
		const draftStream = createDraftStreamController();
		await draftStream.start(channel, "source-message");

		const sentMessages = await draftStream.finalize("final answer");

		expect(sentMessages).toHaveLength(1);
		expect(channel.send).toHaveBeenCalledWith({
			content: "final answer",
			reply: { messageReference: "source-message" },
		});
		expect(sentMessages[0].edit).not.toHaveBeenCalled();
		expect(sentMessages[0].delete).not.toHaveBeenCalled();
	});

	it("posts progress snapshots as additional replies", async () => {
		vi.useFakeTimers();
		const channel = fakeChannel();
		const draftStream = createDraftStreamController({
			minInitialChars: 0,
			throttleMs: 250,
		});
		await draftStream.start(channel, "source-message");

		draftStream.update("working");
		await vi.advanceTimersByTimeAsync(250);
		const sentMessages = await draftStream.finalize("final answer");

		expect(sentMessages).toHaveLength(2);
		expect(channel._messages.map((message) => message.content)).toEqual([
			"working",
			"final answer",
		]);
		for (const message of sentMessages) {
			expect(message.edit).not.toHaveBeenCalled();
			expect(message.delete).not.toHaveBeenCalled();
		}
	});
});
