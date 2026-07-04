/**
 * Unit tests for `setupDiscordEventListeners` DM dispatch — asserts DMs are
 * dispatched directly (and serialized per channel) while channel messages route
 * through the debouncer. Fake discord.js client + mocked debouncer.
 */
import { EventEmitter } from "node:events";
import { ChannelType as DiscordChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the debouncer mock shape from discord-events-config.test.ts so we can
// assert whether channel messages were enqueued vs. DMs dispatched directly.
// DMs are dispatched directly (not batched), so only the channel debouncer is
// mocked here.
const debouncerState = vi.hoisted(() => {
	const channelEnqueue = vi.fn();
	return {
		channelEnqueue,
		createChannelDebouncer: vi.fn(() => ({
			destroy: vi.fn(),
			enqueue: channelEnqueue,
			flushAll: vi.fn(),
			markResponded: vi.fn(),
			pendingCount: vi.fn(() => 0),
		})),
	};
});

vi.mock("../debouncer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../debouncer")>();
	return {
		...actual,
		createChannelDebouncer: debouncerState.createChannelDebouncer,
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
		channelDebouncer: undefined,
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

function makeMessage(
	channelType: DiscordChannelType,
	channelId: string,
	id = `msg-${channelId}`,
) {
	return {
		id,
		content: "hello",
		author: { id: "user-1", bot: false, username: "alice" },
		channel: { id: channelId, type: channelType },
	};
}

// Let the async messageCreate handler settle (it awaits handleMessage). One
// macrotask tick drains the pending microtasks queued by the promise chain.
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("setupDiscordEventListeners — DM dispatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches DMs directly to handleMessage, bypassing the channel debouncer", async () => {
		const service = makeService();
		const { channelDebouncer } = setupDiscordEventListeners(service as never);
		service.channelDebouncer = channelDebouncer as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.DM, "dm-1"),
		);
		await tick();

		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(1);
		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
	});

	it("dispatches group DMs directly to handleMessage, bypassing the channel debouncer", async () => {
		const service = makeService();
		const { channelDebouncer } = setupDiscordEventListeners(service as never);
		service.channelDebouncer = channelDebouncer as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.GroupDM, "gdm-1"),
		);
		await tick();

		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(1);
		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
	});

	it("still routes guild-channel messages through the channel debouncer/enqueue path", async () => {
		const service = makeService();
		const { channelDebouncer } = setupDiscordEventListeners(service as never);
		service.channelDebouncer = channelDebouncer as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.GuildText, "channel-1"),
		);
		await tick();

		expect(debouncerState.channelEnqueue).toHaveBeenCalledTimes(1);
		expect(service.messageManager.handleMessage).not.toHaveBeenCalled();
	});

	it("serializes rapid DMs in the same channel: the second awaits the first, neither dropped", async () => {
		const service = makeService();
		const { channelDebouncer } = setupDiscordEventListeners(service as never);
		service.channelDebouncer = channelDebouncer as never;

		// Record the order handleMessage is entered. The first call hangs on a
		// gate so we can prove the second message cannot start until the first
		// resolves (strict per-channel serialization, one at a time).
		const entered: string[] = [];
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		service.messageManager.handleMessage = vi.fn((message: { id: string }) => {
			entered.push(message.id);
			return entered.length === 1 ? firstGate : Promise.resolve();
		}) as never;

		// Two DMs in the SAME DM channel, emitted back-to-back (the gateway fires
		// messageCreate synchronously in order; the listener is not awaited).
		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.DM, "dm-serial", "dm-msg-1"),
		);
		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.DM, "dm-serial", "dm-msg-2"),
		);
		await tick();

		// Only the first DM is in flight; the second is queued behind it and must
		// NOT have started while the first is still running.
		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(1);
		expect(entered).toEqual(["dm-msg-1"]);

		// Releasing the first lets the queue advance to the second, in order.
		releaseFirst();
		await tick();
		await tick();

		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(2);
		expect(entered).toEqual(["dm-msg-1", "dm-msg-2"]);
	});

	it("a failed DM turn does not stall the queue or drop the next DM", async () => {
		const service = makeService();
		const { channelDebouncer } = setupDiscordEventListeners(service as never);
		service.channelDebouncer = channelDebouncer as never;

		const entered: string[] = [];
		service.messageManager.handleMessage = vi.fn((message: { id: string }) => {
			entered.push(message.id);
			// First turn rejects; the per-channel queue must still run the second.
			return entered.length === 1
				? Promise.reject(new Error("boom"))
				: Promise.resolve();
		}) as never;

		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.DM, "dm-fail", "fail-1"),
		);
		service.client.emit(
			"messageCreate",
			makeMessage(DiscordChannelType.DM, "dm-fail", "fail-2"),
		);
		await tick();
		await tick();

		expect(service.messageManager.handleMessage).toHaveBeenCalledTimes(2);
		expect(entered).toEqual(["fail-1", "fail-2"]);
	});
});
