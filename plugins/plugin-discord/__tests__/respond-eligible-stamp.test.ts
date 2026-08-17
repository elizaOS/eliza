/**
 * Locks the connector-side half of the silent-drop fix (#20755): a plain
 * (no-mention) guild message that passes every delivery gate (allowlisted
 * channel via event listener, autoReply on, strict mode off, no other target)
 * must reach `messageService.handleMessage` with `content.respondEligible ===
 * true` — the flag the core message runtime uses to extend the Stage 1
 * planner fallback (and visible-failure gate) to messages the agent is
 * CONFIGURED to answer. DMs and mention-gated turns keep the flag false: their
 * existing addressing signals (channelType / mentionContext) already cover
 * them. The harness drives the REAL MessageManager with discord.js objects
 * stubbed, mirroring messages-inbound-idempotency.test.ts.
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
// Distinct DM channel identity: the connector's process-wide outbound dedupe
// suppresses an identical account/channel/text tuple within two seconds, so
// the DM case must not reuse the guild channel id (see
// connector-loop.real.test.ts for the same guard).
const DM_CHANNEL_ID = "777000000000000001";
const GUILD_ID = "666555444333222111";
const CLIENT_ID = "888000000000000000";

interface Sent {
	content?: string;
}

interface Harness {
	runtime: ICompatRuntime;
	sends: Sent[];
	dispatchedMessages: Memory[];
}

function makeRuntime(): Harness {
	const memories = new Map<string, Memory>();
	const sends: Sent[] = [];
	const dispatchedMessages: Memory[] = [];
	const rooms = new Map<UUID, { id: UUID; type?: string }>();
	const participantsByRoom = new Map<UUID, UUID[]>();
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
		ensureConnection: vi.fn(
			async (params: { entityId: UUID; roomId: UUID; type?: string }) => {
				rooms.set(params.roomId, { id: params.roomId, type: params.type });
				participantsByRoom.set(params.roomId, [params.entityId, AGENT_ID]);
			},
		),
		getRoom: vi.fn(async (roomId: UUID) => rooms.get(roomId) ?? null),
		getParticipantsForRoom: vi.fn(
			async (roomId: UUID) => participantsByRoom.get(roomId) ?? [],
		),
		reportError: vi.fn(),
		getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
		createMemory: vi.fn(async (memory: Memory) => {
			const id =
				memory.id ?? createUniqueUuid(runtime as ICompatRuntime, randomUUID());
			memories.set(id, { ...memory, id });
			return id;
		}),
		getMemories: vi.fn(async () => []),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				dispatchedMessages.push(message);
				if (message.id && !memories.has(message.id)) {
					await runtime.createMemory(message, "messages");
				}
				await callback({ text: "reply", source: "discord" });
			},
		},
		emitEvent: vi.fn(),
	} as unknown as ICompatRuntime;
	return { runtime, sends, dispatchedMessages };
}

function makeGuildChannel(sends: Sent[], guild: unknown) {
	return {
		id: CHANNEL_ID,
		type: DiscordChannelType.GuildText,
		name: "general",
		guild,
		client: { user: { id: CLIENT_ID } },
		isThread: () => false,
		permissionsFor: () => ({ has: () => true }),
		send: async (options: Sent | string) => {
			const normalized =
				typeof options === "string" ? { content: options } : options;
			sends.push(normalized);
			return {
				id: `99000000000000000${sends.length}`,
				content: normalized.content ?? "",
				url: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/99000000000000000${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
		sendTyping: async () => {},
	};
}

function makeDmChannel(sends: Sent[]) {
	return {
		id: DM_CHANNEL_ID,
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async (options: Sent | string) => {
			const normalized =
				typeof options === "string" ? { content: options } : options;
			sends.push(normalized);
			return {
				id: `99000000000000000${sends.length}`,
				content: normalized.content ?? "",
				url: `https://discord.com/channels/@me/${DM_CHANNEL_ID}/99000000000000000${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
		sendTyping: async () => {},
	};
}

function makeGuild() {
	const botMember = { id: CLIENT_ID };
	const guild: Record<string, unknown> = {
		id: GUILD_ID,
		name: "Test Guild",
		ownerId: "111100000000000000",
		members: { cache: new Map([[CLIENT_ID, botMember]]) },
	};
	guild.fetch = async () => guild;
	return guild;
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
		content: { text: "plain group message", source: "discord" },
	};
}

function makeDiscordService(options: {
	channelType: ChannelType;
	settings?: Record<string, unknown>;
}): IDiscordService {
	return {
		client: { user: { id: CLIENT_ID } },
		accountId: "default",
		getChannelType: async () => options.channelType,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			shouldRespondOnlyToMentions: false,
			replyToMode: "off",
			...(options.settings ?? {}),
		},
		buildMemoryFromMessage: vi.fn(
			async (
				message: DiscordMessage,
				buildOptions?: { extraContent?: Record<string, unknown> },
			) => {
				const memory = makeInboundMemory(message.id);
				return {
					...memory,
					content: {
						...memory.content,
						...(buildOptions?.extraContent ?? {}),
					},
				};
			},
		),
	} as unknown as IDiscordService;
}

function makeInbound(
	channel: unknown,
	options: {
		guild?: unknown;
		messageId?: string;
		mentionsBot?: boolean;
	} = {},
): DiscordMessage {
	const mentionUsers = new Map<string, { id: string }>();
	if (options.mentionsBot) {
		mentionUsers.set(CLIENT_ID, { id: CLIENT_ID });
	}
	return {
		id: options.messageId ?? "666000000000000000",
		content: options.mentionsBot
			? `<@${CLIENT_ID}> plain group message`
			: "plain group message",
		createdTimestamp: Date.now(),
		author: {
			id: AUTHOR_ID,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: options.guild ? { displayName: "Tester" } : null,
		channel,
		guild: options.guild,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: mentionUsers, repliedUser: undefined },
		react: async () => undefined,
		reactions: { resolve: () => null },
	} as unknown as DiscordMessage;
}

describe("respondEligible connector stamp", () => {
	it("stamps respondEligible=true on a plain guild message the agent is configured to answer", async () => {
		const harness = makeRuntime();
		const guild = makeGuild();
		const channel = makeGuildChannel(harness.sends, guild);
		const service = makeDiscordService({ channelType: ChannelType.GROUP });
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(makeInbound(channel, { guild }));

		expect(harness.dispatchedMessages).toHaveLength(1);
		const dispatched = harness.dispatchedMessages[0];
		expect(dispatched.content.respondEligible).toBe(true);
		// The message is genuinely plain: no platform mention, no reply.
		expect(dispatched.content.mentionContext).toMatchObject({
			isMention: false,
			isReply: false,
		});
		expect(harness.sends).toHaveLength(1);
	});

	it("keeps respondEligible=false on DMs (channelType already covers them)", async () => {
		const harness = makeRuntime();
		const channel = makeDmChannel(harness.sends);
		const service = makeDiscordService({ channelType: ChannelType.DM });
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(makeInbound(channel));

		expect(harness.dispatchedMessages).toHaveLength(1);
		expect(harness.dispatchedMessages[0].content.respondEligible).toBe(false);
		expect(harness.sends).toHaveLength(1);
	});

	it("never dispatches (and so never stamps) a plain guild message under strict mentions-only mode", async () => {
		const harness = makeRuntime();
		const guild = makeGuild();
		const channel = makeGuildChannel(harness.sends, guild);
		const service = makeDiscordService({
			channelType: ChannelType.GROUP,
			settings: { shouldRespondOnlyToMentions: true },
		});
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(makeInbound(channel, { guild }));

		expect(harness.dispatchedMessages).toHaveLength(0);
		expect(harness.sends).toHaveLength(0);
	});

	it("stamps respondEligible=true on a mention that passes strict mode", async () => {
		const harness = makeRuntime();
		const guild = makeGuild();
		const channel = makeGuildChannel(harness.sends, guild);
		const service = makeDiscordService({
			channelType: ChannelType.GROUP,
			settings: { shouldRespondOnlyToMentions: true },
		});
		const manager = new MessageManager(service, harness.runtime);

		await manager.handleMessage(
			makeInbound(channel, { guild, mentionsBot: true }),
		);

		expect(harness.dispatchedMessages).toHaveLength(1);
		const dispatched = harness.dispatchedMessages[0];
		expect(dispatched.content.respondEligible).toBe(true);
		expect(dispatched.content.mentionContext).toMatchObject({
			isMention: true,
		});
	});
});
