/**
 * The typing indicator starts when the message service reports the Stage-1
 * respond decision, not when the final reply reaches the send callback, and it
 * never starts or lingers for a turn that does not answer. Drives the real
 * MessageManager with Discord network objects stubbed.
 */
import { randomUUID } from "node:crypto";
import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type Memory,
	type MessageProcessingOptions,
	type UUID,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const AUTHOR_ID = "555000111222333444";
const CHANNEL_ID = "777000000000000001";

type Turn = (
	callback: (content: Content) => Promise<unknown>,
	options: MessageProcessingOptions | undefined,
) => Promise<void>;

function makeHarness(inboundId: string, turn: Turn) {
	const memories = new Map<string, Memory>();
	const sends: string[] = [];
	const sendTyping = vi.fn(async () => {});
	const rooms = new Map<UUID, Record<string, unknown>>();
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		getSetting: () => undefined,
		getService: () => null,
		ensureConnection: vi.fn(async (params: { roomId: UUID }) => {
			rooms.set(params.roomId, { id: params.roomId, ...params });
		}),
		getRoom: vi.fn(async (roomId: UUID) => rooms.get(roomId) ?? null),
		getParticipantsForRoom: vi.fn(async () => []),
		reportError: vi.fn(),
		getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
		createMemory: vi.fn(async (memory: Memory) => {
			const id = memory.id ?? (randomUUID() as UUID);
			memories.set(id, { ...memory, id });
			return id;
		}),
		getMemories: vi.fn(async () => []),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				message: Memory,
				callback: (content: Content) => Promise<unknown>,
				options?: MessageProcessingOptions,
			) => {
				if (message.id) memories.set(message.id, message);
				await turn(callback, options);
			},
		},
		emitEvent: vi.fn(),
	} as unknown as ICompatRuntime;
	const channel = {
		id: CHANNEL_ID,
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async (options: { content?: string }) => {
			sends.push(options.content ?? "");
			return {
				id: `99000000000000000${sends.length}`,
				content: options.content ?? "",
				url: `https://discord.com/channels/@me/${CHANNEL_ID}/${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
		sendTyping,
	};
	const service = {
		client: { user: { id: "888000000000000000" } },
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: vi.fn(async (inbound: DiscordMessage) => ({
			id: createUniqueUuid(runtime, inbound.id),
			entityId: createUniqueUuid(runtime, AUTHOR_ID),
			agentId: AGENT_ID,
			roomId: createUniqueUuid(runtime, CHANNEL_ID),
			content: { text: "hello", source: "discord" },
		})),
	} as unknown as IDiscordService;
	const inbound = {
		id: inboundId,
		content: "hello",
		createdTimestamp: Date.now(),
		author: {
			id: AUTHOR_ID,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: null,
		channel,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: new Map(), repliedUser: undefined },
	} as unknown as DiscordMessage;
	return {
		run: () => new MessageManager(service, runtime).handleMessage(inbound),
		sends,
		sendTyping,
	};
}

describe("Discord typing at the respond decision", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts typing at the decision, before the reply, and does not restart it on send", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let typingAtDecision = -1;
		let typingBeforeReply = -1;
		const harness = makeHarness(
			"666000000000000005",
			async (callback, options) => {
				options?.onResponseDecision?.();
				typingAtDecision = harness.sendTyping.mock.calls.length;
				await new Promise((resolve) => setTimeout(resolve, 5));
				typingBeforeReply = harness.sendTyping.mock.calls.length;
				await callback({ text: "a planned reply", source: "discord" });
			},
		);
		await harness.run();
		expect(typingAtDecision).toBe(1);
		expect(typingBeforeReply).toBe(1);
		expect(harness.sends).toEqual(["a planned reply"]);
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
		// Delivery stopped the heartbeat: no typing after the reply landed.
		vi.advanceTimersByTime(60_000);
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
	});

	it("never types for a turn that ignores the message", async () => {
		const harness = makeHarness("666000000000000006", async () => {});
		await harness.run();
		expect(harness.sendTyping).not.toHaveBeenCalled();
		expect(harness.sends).toEqual([]);
	});

	it("stops a decision-started indicator when the turn ends without a reply", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const harness = makeHarness(
			"666000000000000007",
			async (_callback, options) => {
				options?.onResponseDecision?.();
			},
		);
		await harness.run();
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000);
		expect(harness.sendTyping).toHaveBeenCalledTimes(1);
		expect(harness.sends).toEqual([]);
	});
});
