import { EventEmitter } from "node:events";
import { ChannelType as DiscordChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the debouncer mock shape from discord-events-config.test.ts so we can
// assert whether DM/channel messages were enqueued vs dispatched directly.
const debouncerState = vi.hoisted(() => {
	const messageEnqueue = vi.fn();
	const channelEnqueue = vi.fn();
	return {
		messageEnqueue,
		channelEnqueue,
		createChannelDebouncer: vi.fn(() => ({
			destroy: vi.fn(),
			enqueue: channelEnqueue,
			flushAll: vi.fn(),
			markResponded: vi.fn(),
			pendingCount: vi.fn(() => 0),
		})),
		createMessageDebouncer: vi.fn(() => ({
			destroy: vi.fn(),
			enqueue: messageEnqueue,
			flushAll: vi.fn(),
			pendingCount: vi.fn(() => 0),
		})),
	};
});

vi.mock("../debouncer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../debouncer")>();
	return {
		...actual,
		createChannelDebouncer: debouncerState.createChannelDebouncer,
		createMessageDebouncer: debouncerState.createMessageDebouncer,
	};
});

import { setupDiscordEventListeners } from "../discord-events";

const BOT_ID = "123";

function makeService() {
	const client = new EventEmitter() as EventEmitter & {
		user?: { id: string };
	};
	client.user = { id: BOT_ID };
	return {
		accountId: "test",
		allowAllSlashCommands: new Set(),
		allowedChannelIds: undefined,
		buildMemoryFromMessage: vi.fn(),
		character: {},
		client,
		discordSettings: {
			shouldIgnoreBotMessages: true,
			shouldRespondOnlyToMentions: false,
		},
		getChannelType: vi.fn(),
		handleGuildCreate: vi.fn(),
		handleGuildMemberAdd: vi.fn(),
		handleInteractionCreate: vi.fn(),
		handleReactionAdd: vi.fn(),
		handleReactionRemove: vi.fn(),
		isChannelAllowed: vi.fn(() => true),
		messageDebouncer: undefined,
		messageManager: { handleMessage: vi.fn() },
		resolveDiscordEntityId: vi.fn(),
		runtime: {
			agentId: "agent",
			emitEvent: vi.fn(),
			getSetting: vi.fn(() => undefined),
			logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		},
		slashCommands: [],
		timeouts: [],
		userSelections: new Map(),
		voiceManager: undefined,
	};
}

function makeMessage(channelType: DiscordChannelType, channelId: string) {
	return {
		id: `msg-${channelId}`,
		content: "hello",
		author: { id: "user-1", bot: false, username: "alice" },
		channel: { id: channelId, type: channelType },
	};
}

// Let the async messageCreate handler settle (it awaits handleMessage).
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("setupDiscordEventListeners — DM dispatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches DMs directly to handleMessage, bypassing the message-debouncer", async () => {
		const service = makeService();
		// The message-debouncer is wired by setup; the DM path must still bypass it.
		const { messageDebouncer } = setupDiscordEventListeners(service as never);
		service.messageDebouncer = messageDebouncer as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.DM, "dm-1"),
		);
		await tick();

		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(1);
		expect(debouncerState.messageEnqueue).not.toHaveBeenCalled();
		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
	});

	it("dispatches group DMs directly to handleMessage, bypassing the message-debouncer", async () => {
		const service = makeService();
		const { messageDebouncer } = setupDiscordEventListeners(service as never);
		service.messageDebouncer = messageDebouncer as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.GroupDM, "gdm-1"),
		);
		await tick();

		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(1);
		expect(debouncerState.messageEnqueue).not.toHaveBeenCalled();
		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
	});

	it("still routes guild-channel messages through the channel debouncer/enqueue path", async () => {
		const service = makeService();
		const { messageDebouncer, channelDebouncer } = setupDiscordEventListeners(
			service as never,
		);
		service.messageDebouncer = messageDebouncer as never;
		service.channelDebouncer = channelDebouncer as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.GuildText, "channel-1"),
		);
		await tick();

		expect(debouncerState.channelEnqueue).toHaveBeenCalledTimes(1);
		expect(service.messageManager.handleMessage).not.toHaveBeenCalled();
		expect(debouncerState.messageEnqueue).not.toHaveBeenCalled();
	});
});
