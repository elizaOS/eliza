/**
 * Unit tests for `setupDiscordEventListeners` config wiring and
 * response-cooldown gating, driven with a fake discord.js client (EventEmitter)
 * and mocked debouncer.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const debouncerState = vi.hoisted(() => {
	// A stable spy the channel-debouncer flush callback closes over via the
	// returned debouncer, so a test can assert whether the cooldown was armed.
	const channelMarkResponded = vi.fn();
	let lastChannelFlush: ((messages: unknown[]) => void) | undefined;
	return {
		channelMarkResponded,
		getLastChannelFlush: () => lastChannelFlush,
		createChannelDebouncer: vi.fn((onFlush: (messages: unknown[]) => void) => {
			lastChannelFlush = onFlush;
			return {
				destroy: vi.fn(),
				enqueue: vi.fn(),
				flushAll: vi.fn(),
				markResponded: channelMarkResponded,
				pendingCount: vi.fn(() => 0),
			};
		}),
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

function makeService(shouldRespondOnlyToMentions: boolean) {
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
			shouldRespondOnlyToMentions,
		},
		getChannelType: vi.fn(),
		handleGuildCreate: vi.fn(),
		handleGuildMemberAdd: vi.fn(),
		handleInteractionCreate: vi.fn(),
		handleReactionAdd: vi.fn(),
		handleReactionRemove: vi.fn(),
		isChannelAllowed: vi.fn(() => true),
		// A truthy manager so the flush callback runs past its early-return; the
		// cooldown gate fires after handleMessage regardless of what it does.
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

function flushMsg(content: string) {
	return {
		content,
		channel: { id: "channel-1" },
		reference: undefined,
		mentions: { repliedUser: undefined },
		author: { username: "alice", displayName: "Alice", globalName: "Alice" },
		member: { displayName: "Alice" },
	};
}

describe("setupDiscordEventListeners config", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses resolved Discord service settings for mention-only mode", () => {
		setupDiscordEventListeners(makeService(false) as never);

		expect(debouncerState.createChannelDebouncer).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				shouldRespondOnlyToMentions: false,
			}),
		);
	});
});

// The cooldown-gating half of the "@bot ^^" pointer fix lives in the flush
// callback, not the debouncer: a purely-unaddressed batch must NOT arm the
// 30s response cooldown in strict mode, or the next unaddressed message (e.g.
// a question typed just before a pointer) is dropped before it can be buffered.
// The debouncer unit tests mock this layer out, so it is otherwise untested.
describe("setupDiscordEventListeners — response-cooldown gating", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not arm the cooldown for a purely-unaddressed batch (strict mode)", () => {
		setupDiscordEventListeners(makeService(true) as never);
		const onFlush = debouncerState.getLastChannelFlush();
		expect(onFlush).toBeTypeOf("function");

		onFlush?.([flushMsg("just some channel chatter")]);

		expect(debouncerState.channelMarkResponded).not.toHaveBeenCalled();
	});

	it("arms the cooldown when the bot is addressed (strict mode)", () => {
		setupDiscordEventListeners(makeService(true) as never);
		const onFlush = debouncerState.getLastChannelFlush();

		onFlush?.([flushMsg(`<@${BOT_ID}> ^^`)]);

		expect(debouncerState.channelMarkResponded).toHaveBeenCalledWith(
			"channel-1",
		);
	});

	it("arms the cooldown for any batch in respond-to-all mode", () => {
		setupDiscordEventListeners(makeService(false) as never);
		const onFlush = debouncerState.getLastChannelFlush();

		onFlush?.([flushMsg("just some channel chatter")]);

		expect(debouncerState.channelMarkResponded).toHaveBeenCalledWith(
			"channel-1",
		);
	});
});
