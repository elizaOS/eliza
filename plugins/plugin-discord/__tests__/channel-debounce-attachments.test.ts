/**
 * A channel batch flushed by the debouncer is handled as one message. The
 * files of every message in the batch must reach that message, not only the
 * anchor's: an image posted just before "@bot what is this?" is the subject of
 * the question. Real setupDiscordEventListeners + debouncer; the Discord
 * client and message manager are stand-ins.
 */
import { Collection, type Message } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { setupDiscordEventListeners } from "../discord-events.ts";

const BOT_ID = "999";
let destroy: (() => void) | undefined;

afterEach(() => {
	destroy?.();
	destroy = undefined;
});

function message(id: string, content: string, files: string[]): Message {
	return {
		id,
		content,
		channel: { id: "channel-1" },
		author: { id: "user-1", username: "alice", displayName: "Alice" },
		mentions: { repliedUser: undefined },
		reference: null,
		attachments: new Collection(files.map((url) => [url, { id: url, url }])),
		embeds: [],
	} as unknown as Message;
}

function listenersWith(settings: Record<string, string>) {
	const handled: Message[] = [];
	const service = {
		runtime: {
			agentId: "00000000-0000-4000-8000-000000000001",
			getSetting: (key: string) => settings[key],
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			reportError() {},
		},
		client: { user: { id: BOT_ID }, on() {}, once() {} },
		messageManager: {
			handleMessage: async (handledMessage: Message) => {
				handled.push(handledMessage);
			},
		},
		discordSettings: {},
	};
	const { channelDebouncer } = setupDiscordEventListeners(
		service as unknown as Parameters<typeof setupDiscordEventListeners>[0],
	);
	destroy = () => channelDebouncer.destroy();
	return { channelDebouncer, handled };
}

describe("Discord channel batch attachments", () => {
	it.each([
		["debounced", {}],
		["coalesced", { DISCORD_MESSAGE_COALESCE_ENABLED: "true" }],
	] as const)(
		"keeps an image posted just before the mention (%s)",
		async (_mode, settings) => {
			const { channelDebouncer, handled } = listenersWith(settings);
			channelDebouncer.enqueue(
				message("m1", "", ["https://cdn.discordapp.com/photo.png"]),
			);
			channelDebouncer.enqueue(
				message("m2", `<@${BOT_ID}> what is in this picture?`, []),
			);
			channelDebouncer.flushAll();
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(handled).toHaveLength(1);
			expect([...handled[0].attachments.keys()]).toEqual([
				"https://cdn.discordapp.com/photo.png",
			]);
		},
	);
});
