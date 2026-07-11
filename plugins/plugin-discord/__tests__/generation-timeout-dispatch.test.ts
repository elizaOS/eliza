/**
 * Integration coverage for the Discord generation-timeout DISPATCH path:
 * drives the REAL `MessageManager.handleMessage` and asserts the connector
 * now (a) threads an `abortSignal` into `messageService.handleMessage`,
 * (b) ABORTS that signal when the generation timeout fires, and (c) sends
 * exactly ONE "I timed out" reply without a second dispatch when the
 * orphaned run resolves late.
 *
 * This is the connector-level reproduction of the screenshot bug: real
 * questions hit the ~2min timeout while the underlying model call kept
 * running as an orphan (no abort), able to race a late response into the
 * same room and poison the next slot.
 *
 * Uses fake timers to fast-forward the (30s-floored) generation timeout.
 * Only the discord.js SDK surface is stubbed — no token, no network.
 */
import type { Content, Memory, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const noop = () => {};

const INBOUND_MEMORY: Memory = {
	id: "12345678-1234-1234-1234-123456789abc" as UUID,
	entityId: "87654321-4321-4321-4321-cba987654321" as UUID,
	agentId: AGENT_ID,
	roomId: "11111111-2222-3333-4444-555555555555" as UUID,
	content: { text: "a real question that takes a while", source: "discord" },
};

interface Sent {
	content?: string;
}

interface HandleMessageOptions {
	abortSignal?: AbortSignal;
}

/**
 * Runtime whose messageService HANGS (never resolves) and records the
 * abortSignal it was handed. Lets the test assert the timeout aborts it.
 */
function makeHangingRuntime(settings: Record<string, string> = {}): {
	runtime: ICompatRuntime;
	errors: string[];
	captured: { signal?: AbortSignal };
	handleCalls: number;
} {
	const errors: string[] = [];
	const captured: { signal?: AbortSignal } = {};
	let handleCalls = 0;
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: noop,
			info: noop,
			warn: noop,
			error: (...args: unknown[]) => {
				errors.push(JSON.stringify(args));
			},
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS"
				? "false"
				: (settings[key] ?? undefined),
		getService: () => null,
		ensureConnection: async () => {},
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		messageService: {
			handleMessage: (
				_runtime: unknown,
				_message: Memory,
				_callback: (content: Content) => Promise<unknown>,
				options?: HandleMessageOptions,
			) => {
				handleCalls += 1;
				captured.signal = options?.abortSignal;
				// Hang forever — simulates a slow/stuck model call.
				return new Promise<never>(() => {});
			},
		},
	} as unknown as ICompatRuntime;
	return {
		runtime,
		errors,
		captured,
		get handleCalls() {
			return handleCalls;
		},
	};
}

function makeDmChannel(sends: Sent[]) {
	return {
		id: "777000000000000000",
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async (options: Sent) => {
			sends.push(options);
			return { id: "990000000000000001", ...options };
		},
		sendTyping: async () => {},
	};
}

function makeDiscordService(client: unknown): IDiscordService {
	return {
		client,
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: async () => INBOUND_MEMORY,
	} as unknown as IDiscordService;
}

function makeInbound(channel: unknown): DiscordMessage {
	return {
		id: "666000000000000000",
		content: "a real question that takes a while",
		createdTimestamp: Date.now(),
		author: {
			id: "555000111222333444",
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: null,
		channel,
		guild: undefined,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: {
			users: new Map(),
			repliedUser: undefined,
			has: () => true,
		},
	} as unknown as DiscordMessage;
}

describe("Discord generation timeout aborts the underlying run (dispatch path)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("aborts the abortSignal handed to messageService when the timeout fires", async () => {
		const sends: Sent[] = [];
		const channel = makeDmChannel(sends);
		const client = { user: { id: "888000000000000000" } };
		// 30s floor is the smallest the resolver allows.
		const { runtime, captured } = makeHangingRuntime({
			DISCORD_GENERATION_TIMEOUT_MS: "30000",
		});
		const manager = new MessageManager(makeDiscordService(client), runtime);

		const handled = manager.handleMessage(makeInbound(channel));
		// Let inbound guards + memory build + dispatch reach the hanging call.
		await vi.advanceTimersByTimeAsync(0);
		expect(captured.signal).toBeDefined();
		expect(captured.signal?.aborted).toBe(false);

		// Fire the generation timeout.
		await vi.advanceTimersByTimeAsync(30_000);
		await handled;

		// The abort MUST have propagated to the model-facing signal.
		expect(captured.signal?.aborted).toBe(true);
		// Exactly one timeout reply.
		const timeoutReplies = sends.filter((s) =>
			String(s.content).includes("timed out"),
		);
		expect(timeoutReplies).toHaveLength(1);
	});

	it("does not double-dispatch when the orphaned run resolves late", async () => {
		const sends: Sent[] = [];
		const channel = makeDmChannel(sends);
		const client = { user: { id: "888000000000000000" } };

		// Runtime whose handleMessage resolves LATE (after the timeout) via a
		// gate we control, and never emits a response through the callback.
		let release: (() => void) | undefined;
		let handleCalls = 0;
		let capturedSignal: AbortSignal | undefined;
		const runtime = {
			agentId: AGENT_ID,
			character: { name: "Eliza" },
			logger: { debug: noop, info: noop, warn: noop, error: noop },
			getSetting: (key: string) =>
				key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS"
					? "false"
					: key === "DISCORD_GENERATION_TIMEOUT_MS"
						? "30000"
						: undefined,
			getService: () => null,
			ensureConnection: async () => {},
			getMemoryById: async () => null,
			createMemory: async (memory: Memory) => memory.id,
			messageService: {
				handleMessage: (
					_r: unknown,
					_m: Memory,
					_cb: (content: Content) => Promise<unknown>,
					options?: HandleMessageOptions,
				) => {
					handleCalls += 1;
					capturedSignal = options?.abortSignal;
					return new Promise<void>((resolve) => {
						release = resolve;
					});
				},
			},
		} as unknown as ICompatRuntime;

		const manager = new MessageManager(makeDiscordService(client), runtime);
		const handled = manager.handleMessage(makeInbound(channel));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(30_000);
		await handled;

		expect(capturedSignal?.aborted).toBe(true);
		const timeoutRepliesBefore = sends.filter((s) =>
			String(s.content).includes("timed out"),
		).length;
		expect(timeoutRepliesBefore).toBe(1);

		// Orphan resolves LATE — must not trigger a second dispatch or a
		// second outbound message.
		release?.();
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();

		expect(handleCalls).toBe(1);
		const timeoutRepliesAfter = sends.filter((s) =>
			String(s.content).includes("timed out"),
		).length;
		expect(timeoutRepliesAfter).toBe(1);
	});

	it("drops a late text-only callback after timeout — late drift never reaches the wire (#15888)", async () => {
		// After the timeout reply is sent, an orphaned run may still push text
		// through the response callback. Text-only late deliveries are dropped
		// (only long-running MEDIA may deliver late), so even a reply that
		// drifted into native tool syntax cannot leak onto the wire through the
		// late path — defense in depth behind the shared core sanitizer.
		const sends: Sent[] = [];
		const channel = makeDmChannel(sends);
		const client = { user: { id: "888000000000000000" } };

		let capturedCallback: ((content: Content) => Promise<unknown>) | undefined;
		const runtime = {
			agentId: AGENT_ID,
			character: { name: "Eliza" },
			logger: { debug: noop, info: noop, warn: noop, error: noop },
			getSetting: (key: string) =>
				key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS"
					? "false"
					: key === "DISCORD_GENERATION_TIMEOUT_MS"
						? "30000"
						: undefined,
			getService: () => null,
			ensureConnection: async () => {},
			getMemoryById: async () => null,
			createMemory: async (memory: Memory) => memory.id,
			messageService: {
				handleMessage: (
					_r: unknown,
					_m: Memory,
					cb: (content: Content) => Promise<unknown>,
				) => {
					capturedCallback = cb;
					// Hang past the timeout — simulates the orphaned run.
					return new Promise<never>(() => {});
				},
			},
		} as unknown as ICompatRuntime;

		const manager = new MessageManager(makeDiscordService(client), runtime);
		const handled = manager.handleMessage(makeInbound(channel));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(30_000);
		await handled;

		const sendsAfterTimeout = sends.length;
		expect(sendsAfterTimeout).toBeGreaterThan(0);
		expect(capturedCallback).toBeDefined();

		const lateResult = await capturedCallback?.({
			text: "Here is that late answer.<tool_call>get_weather",
		});

		expect(lateResult).toEqual([]);
		expect(sends).toHaveLength(sendsAfterTimeout);
	});

	/**
	 * The abort must NOT break the `activeTaskAgentWork` suppression path.
	 * Background task-agents (SWARM_COORDINATOR) run in a SEPARATE service,
	 * decoupled from the inbound handleMessage streaming context, so aborting
	 * the inline generation does not kill them. When a task-agent is still
	 * working on this message, the timeout reply is SUPPRESSED (the agent will
	 * deliver its result later) even though the inline signal was aborted.
	 */
	it("suppresses the timeout reply while task-agent work is active (abort still safe)", async () => {
		const sends: Sent[] = [];
		const channel = makeDmChannel(sends);
		const client = { user: { id: "888000000000000000" } };

		// A live task-agent whose originating messageId matches the inbound
		// memory id — this is what hasActiveTaskAgentWorkForMessage keys on.
		const tasks = new Map<string, unknown>([
			[
				"session-1",
				{
					status: "tool_running",
					originMetadata: { messageId: INBOUND_MEMORY.id },
				},
			],
		]);

		let capturedSignal: AbortSignal | undefined;
		const runtime = {
			agentId: AGENT_ID,
			character: { name: "Eliza" },
			logger: { debug: noop, info: noop, warn: noop, error: noop },
			getSetting: (key: string) =>
				key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS"
					? "false"
					: key === "DISCORD_GENERATION_TIMEOUT_MS"
						? "30000"
						: undefined,
			getService: (serviceType: string) =>
				serviceType === "SWARM_COORDINATOR" ? { tasks } : null,
			ensureConnection: async () => {},
			getMemoryById: async () => null,
			createMemory: async (memory: Memory) => memory.id,
			messageService: {
				handleMessage: (
					_r: unknown,
					_m: Memory,
					_cb: (content: Content) => Promise<unknown>,
					options?: HandleMessageOptions,
				) => {
					capturedSignal = options?.abortSignal;
					return new Promise<never>(() => {});
				},
			},
		} as unknown as ICompatRuntime;

		const manager = new MessageManager(makeDiscordService(client), runtime);
		const handled = manager.handleMessage(makeInbound(channel));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(30_000);
		await handled;

		// Abort fired (harmless — the task-agent lives in a separate service).
		expect(capturedSignal?.aborted).toBe(true);
		// But NO timeout reply: the task-agent will deliver its result later.
		const timeoutReplies = sends.filter((s) =>
			String(s.content).includes("timed out"),
		);
		expect(timeoutReplies).toHaveLength(0);
	});
});
