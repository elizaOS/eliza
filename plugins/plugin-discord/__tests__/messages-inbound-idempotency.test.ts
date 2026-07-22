/**
 * Discord inbound idempotency tests drive the manager boundary where a gateway
 * message becomes a durable message memory and then a model turn. The harness
 * keeps Discord network objects stubbed while preserving the real manager
 * ordering: memory build, connection setup, inbound persistence, model dispatch,
 * and outbound callback persistence.
 */
import { randomUUID } from "node:crypto";
import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type Memory,
	type UUID,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const AUTHOR_ID = "555000111222333444";
const CHANNEL_ID = "777000000000000000";
const CLIENT_ID = "888000000000000000";
const DISCORD_MESSAGE_ID = "666000000000000000";

interface Sent {
	content?: string;
}

interface RuntimeHarness {
	runtime: ICompatRuntime;
	memories: Map<string, Memory>;
	sends: Sent[];
	handleCalls: () => number;
}

function makeRuntime(options?: {
	failFirstHandleBeforePersistence?: boolean;
}): RuntimeHarness {
	const memories = new Map<string, Memory>();
	const sends: Sent[] = [];
	let handleCalls = 0;
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ? "false" : undefined,
		getService: () => null,
		ensureConnection: vi.fn(async () => {}),
		getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
		createMemory: vi.fn(async (memory: Memory) => {
			const id =
				memory.id ?? createUniqueUuid(runtime as ICompatRuntime, randomUUID());
			memories.set(id, { ...memory, id });
			return id;
		}),
		upsertMemory: vi.fn(async (memory: Memory) => {
			const id =
				memory.id ?? createUniqueUuid(runtime as ICompatRuntime, randomUUID());
			memories.set(id, { ...memory, id });
		}),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				handleCalls += 1;
				if (options?.failFirstHandleBeforePersistence && handleCalls === 1) {
					throw new Error("generation failed before inbound persistence");
				}
				if (message.id && !memories.has(message.id)) {
					await runtime.createMemory(message, "messages");
				}
				await callback({ text: "one durable reply", source: "discord" });
			},
		},
		emitEvent: vi.fn(),
	} as unknown as ICompatRuntime;
	return { runtime, memories, sends, handleCalls: () => handleCalls };
}

function makeDmChannel(sends: Sent[]) {
	return {
		id: CHANNEL_ID,
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async (options: Sent) => {
			sends.push(options);
			return {
				id: `99000000000000000${sends.length}`,
				content: options.content ?? "",
				url: `https://discord.com/channels/@me/${CHANNEL_ID}/99000000000000000${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
		sendTyping: async () => {},
	};
}

function makeInboundMemory(messageId: string): Memory {
	return {
		id: createUniqueUuid(
			{ agentId: AGENT_ID } as ICompatRuntime,
			messageId,
		) as UUID,
		entityId: createUniqueUuid(
			{ agentId: AGENT_ID } as ICompatRuntime,
			AUTHOR_ID,
		) as UUID,
		agentId: AGENT_ID,
		roomId: createUniqueUuid(
			{ agentId: AGENT_ID } as ICompatRuntime,
			CHANNEL_ID,
		) as UUID,
		content: { text: "hello", source: "discord" },
	};
}

function makeDiscordService(
	client: unknown,
	buildMemoryFromMessage = vi.fn(async (message: DiscordMessage) =>
		makeInboundMemory(message.id),
	),
): IDiscordService & {
	buildMemoryFromMessage: ReturnType<typeof vi.fn>;
} {
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
		buildMemoryFromMessage,
	} as unknown as IDiscordService & {
		buildMemoryFromMessage: ReturnType<typeof vi.fn>;
	};
}

function makeInbound(
	channel: unknown,
	messageId = DISCORD_MESSAGE_ID,
): DiscordMessage {
	return {
		id: messageId,
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
		guild: undefined,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: new Map(), repliedUser: undefined },
	} as unknown as DiscordMessage;
}

describe("Discord inbound durable idempotency", () => {
	it("preserves first delivery and suppresses a duplicate messageCreate in the same manager", async () => {
		const harness = makeRuntime();
		const channel = makeDmChannel(harness.sends);
		const service = makeDiscordService({ user: { id: CLIENT_ID } });
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(makeInbound(channel));
		await manager.handleMessage(makeInbound(channel));

		expect(service.buildMemoryFromMessage).toHaveBeenCalledTimes(1);
		expect(harness.handleCalls()).toBe(1);
		expect(harness.sends).toHaveLength(1);
		expect(
			harness.memories.has(makeInboundMemory(DISCORD_MESSAGE_ID).id as string),
		).toBe(true);
	});

	it("suppresses a duplicate after manager reconstruction when inbound memory was persisted", async () => {
		const messageId = "666000000000000001";
		const harness = makeRuntime();
		const channel = makeDmChannel(harness.sends);
		const firstService = makeDiscordService({ user: { id: CLIENT_ID } });
		const firstManager = new MessageManager(firstService, harness.runtime);

		await firstManager.handleMessage(makeInbound(channel, messageId));

		const secondService = makeDiscordService({ user: { id: CLIENT_ID } });
		const reconstructedManager = new MessageManager(
			secondService,
			harness.runtime,
		);
		await reconstructedManager.handleMessage(makeInbound(channel, messageId));

		expect(firstService.buildMemoryFromMessage).toHaveBeenCalledTimes(1);
		expect(secondService.buildMemoryFromMessage).toHaveBeenCalledTimes(1);
		expect(harness.handleCalls()).toBe(1);
		expect(harness.sends).toHaveLength(1);
		expect(harness.runtime.logger.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId,
				memoryId: makeInboundMemory(messageId).id,
			}),
			"Skipping already persisted Discord inbound message",
		);
	});

	it("allows a reconstructed manager to retry when the first delivery failed before persistence", async () => {
		const messageId = "666000000000000002";
		const harness = makeRuntime();
		const channel = makeDmChannel(harness.sends);
		const failingService = makeDiscordService(
			{ user: { id: CLIENT_ID } },
			vi.fn(async () => {
				throw new Error("memory build failed");
			}),
		);
		const firstManager = new MessageManager(failingService, harness.runtime);

		await firstManager.handleMessage(makeInbound(channel, messageId));

		const retryService = makeDiscordService({ user: { id: CLIENT_ID } });
		const reconstructedManager = new MessageManager(
			retryService,
			harness.runtime,
		);
		await reconstructedManager.handleMessage(makeInbound(channel, messageId));

		expect(failingService.buildMemoryFromMessage).toHaveBeenCalledTimes(1);
		expect(retryService.buildMemoryFromMessage).toHaveBeenCalledTimes(1);
		expect(harness.handleCalls()).toBe(1);
		expect(harness.sends).toHaveLength(1);
		expect(
			harness.memories.has(makeInboundMemory(messageId).id as string),
		).toBe(true);
	});

	it("releases the same-process duplicate guard when processing fails before persistence", async () => {
		const messageId = "666000000000000003";
		const harness = makeRuntime();
		const channel = makeDmChannel(harness.sends);
		const buildMemoryFromMessage = vi
			.fn()
			.mockRejectedValueOnce(new Error("memory build failed"))
			.mockImplementation(async (message: DiscordMessage) =>
				makeInboundMemory(message.id),
			);
		const service = makeDiscordService(
			{ user: { id: CLIENT_ID } },
			buildMemoryFromMessage,
		);
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(makeInbound(channel, messageId));
		await manager.handleMessage(makeInbound(channel, messageId));

		expect(buildMemoryFromMessage).toHaveBeenCalledTimes(2);
		expect(harness.handleCalls()).toBe(1);
		expect(harness.sends).toHaveLength(1);
	});
	it("retries in the same manager when generation fails before inbound persistence", async () => {
		const messageId = "666000000000000004";
		const harness = makeRuntime({ failFirstHandleBeforePersistence: true });
		const channel = makeDmChannel(harness.sends);
		const service = makeDiscordService({ user: { id: CLIENT_ID } });
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(makeInbound(channel, messageId));
		await manager.handleMessage(makeInbound(channel, messageId));

		expect(service.buildMemoryFromMessage).toHaveBeenCalledTimes(2);
		expect(harness.handleCalls()).toBe(2);
		expect(harness.sends).toHaveLength(2);
		expect(
			harness.memories.has(makeInboundMemory(messageId).id as string),
		).toBe(true);
	});
});
