/**
 * Discord reply persistence keeps one dialogue row per reply. The message
 * service persists the reply under `content.responseId`; the delivery callback
 * must merge the platform facts into that same row whichever write lands first,
 * and must fall back to its own derived row only when no canonical id exists.
 *
 * Drives the REAL `MessageManager.handleMessage` with a stub runtime whose
 * message service invokes the response callback, and captures every memory
 * write. Runtime services and discord.js objects are stubbed here; SQL races
 * are covered separately in messages-reply-persistence.real.test.ts. No network.
 */
import type { Content, Memory, UUID } from "@elizaos/core";
import { ChannelType, createUniqueUuid } from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const RESPONSE_ID = "0f0f0f0f-1111-4222-8333-444455556666" as UUID;
const noop = () => {};

const INBOUND_MEMORY: Memory = {
	id: "12345678-1234-1234-1234-123456789abc" as UUID,
	entityId: "87654321-4321-4321-4321-cba987654321" as UUID,
	agentId: AGENT_ID,
	roomId: createUniqueUuid({ agentId: AGENT_ID }, "777000000000000000"),
	content: { text: "which one?", source: "discord" },
};

interface Writes {
	created: Memory[];
	updated: Array<Partial<Memory> & { id: UUID }>;
	errors: string[];
}

function makeRuntime(
	replyContent: Content,
	existing: Memory | null,
): { runtime: ICompatRuntime; writes: Writes } {
	const writes: Writes = { created: [], updated: [], errors: [] };
	const stored = new Map<UUID, Memory>();
	if (existing?.id) stored.set(existing.id, existing);
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: noop,
			info: noop,
			warn: noop,
			error: (...args: unknown[]) => {
				writes.errors.push(JSON.stringify(args));
			},
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ? "false" : undefined,
		getService: () => null,
		ensureConnection: async () => {},
		getRoom: async () => ({ id: INBOUND_MEMORY.roomId, type: ChannelType.DM }),
		getParticipantsForRoom: async () => [INBOUND_MEMORY.entityId, AGENT_ID],
		reportError: (...args: unknown[]) => {
			writes.errors.push(JSON.stringify(args));
		},
		getMemoryById: async (id: UUID) => stored.get(id) ?? null,
		createMemory: async (memory: Memory) => {
			writes.created.push(memory);
			if (memory.id && !stored.has(memory.id)) stored.set(memory.id, memory);
			return memory.id;
		},
		updateMemory: async (memory: Partial<Memory> & { id: UUID }) => {
			writes.updated.push(memory);
			return true;
		},
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				_message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				await callback(structuredClone(replyContent));
			},
		},
	} as unknown as ICompatRuntime;
	return { runtime, writes };
}

let inboundSequence = 0;

function makeInbound(channel: unknown, authorId: string): DiscordMessage {
	// The connector de-duplicates repeated replies per inbound message, so each
	// case needs its own inbound id.
	inboundSequence += 1;
	return {
		id: `66600000000000${String(inboundSequence).padStart(4, "0")}`,
		content: "which one?",
		createdTimestamp: Date.now(),
		author: {
			id: authorId,
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

function makeService(client: unknown): IDiscordService {
	return {
		client,
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
		buildMemoryFromMessage: async () => INBOUND_MEMORY,
	} as unknown as IDiscordService;
}

async function deliver(
	replyContent: Content,
	existing: Memory | null,
): Promise<{ writes: Writes; sentIds: string[] }> {
	const sentIds: string[] = [];
	const dmUser = {
		id: "555000111222333444",
		send: async (options: { content?: string }) => {
			const id = `99000000000000000${sentIds.length + 1}`;
			sentIds.push(id);
			return {
				id,
				content: options.content ?? "",
				url: `https://discord.com/channels/@me/1/${id}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
				edit: async () => ({ id }),
			};
		},
	};
	const client = {
		user: { id: "888000000000000000" },
		users: { fetch: async () => dmUser },
	};
	const channel = {
		id: "777000000000000000",
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async () => {
			throw new Error("DM replies must go through user.send");
		},
	};
	const { runtime, writes } = makeRuntime(replyContent, existing);
	const manager = new MessageManager(makeService(client), runtime);
	await manager.handleMessage(makeInbound(channel, dmUser.id));
	expect(writes.errors).toEqual([]);
	// The inbound path also writes turn-state rows for the sender; only the
	// agent-authored rows are the reply persistence under test.
	writes.created = writes.created.filter(
		(memory) => memory.entityId === AGENT_ID,
	);
	return { writes, sentIds };
}

describe("Discord reply persistence keeps one row per reply", () => {
	it("persists the delivery under the reply's canonical id when it writes first", async () => {
		const { writes, sentIds } = await deliver(
			{ text: "Sure thing.", channelType: "DM", responseId: RESPONSE_ID },
			null,
		);
		expect(sentIds).toHaveLength(1);
		expect(writes.updated).toHaveLength(1);
		expect(writes.created).toHaveLength(1);
		const row = writes.created[0];
		expect(row.id).toBe(RESPONSE_ID);
		expect(row.content.text).toBe("Sure thing.");
		expect(row.content.source).toBe("discord");
		expect(row.content.inReplyTo).toBe(INBOUND_MEMORY.id);
		expect(row.metadata).toMatchObject({
			platformMessageId: sentIds[0],
			platformMessageIds: sentIds,
			scope: "room",
		});
	});

	it("merges the delivery facts into the row the message service already wrote", async () => {
		const existing: Memory = {
			id: RESPONSE_ID,
			entityId: AGENT_ID,
			agentId: AGENT_ID,
			roomId: INBOUND_MEMORY.roomId,
			content: { text: "Sure thing.", actions: ["REPLY"] },
			metadata: { type: "message" } as Memory["metadata"],
		};
		const { writes, sentIds } = await deliver(
			{
				text: "Sure thing, merged.",
				channelType: "DM",
				responseId: RESPONSE_ID,
			},
			existing,
		);
		expect(writes.created).toEqual([]);
		expect(writes.updated).toHaveLength(1);
		const update = writes.updated[0];
		expect(update.id).toBe(RESPONSE_ID);
		expect(update.content?.text).toBe("Sure thing.");
		expect(update.content?.actions).toEqual(["REPLY"]);
		expect(update.content?.source).toBe("discord");
		expect(update.content?.inReplyTo).toBe(INBOUND_MEMORY.id);
		expect(update.content?.url).toContain(sentIds[0]);
		expect(update.metadata).toMatchObject({
			type: "message",
			platformMessageId: sentIds[0],
			platformMessageIds: sentIds,
		});
	});

	it("keeps the complete text once for a chunked reply and lists every chunk id", async () => {
		const longText = Array.from(
			{ length: 420 },
			(_, index) => `sentence number ${index} of a long answer.`,
		).join(" ");
		const { writes, sentIds } = await deliver(
			{ text: longText, channelType: "DM", responseId: RESPONSE_ID },
			null,
		);
		expect(sentIds.length).toBeGreaterThan(1);
		expect(writes.created).toHaveLength(1);
		expect(writes.created[0].id).toBe(RESPONSE_ID);
		expect(writes.created[0].content.text).toBe(longText);
		expect(writes.created[0].metadata).toMatchObject({
			platformMessageId: sentIds[0],
			platformMessageIds: sentIds,
		});
	});

	it("falls back to a delivery-derived row when the reply carries no canonical id", async () => {
		const { writes, sentIds } = await deliver(
			{ text: "Sure thing, legacy row.", channelType: "DM" },
			null,
		);
		expect(writes.updated).toEqual([]);
		expect(writes.created).toHaveLength(1);
		expect(writes.created[0].id).not.toBe(RESPONSE_ID);
		expect(writes.created[0].metadata).toMatchObject({
			platformMessageId: sentIds[0],
		});
		expect(writes.created[0].metadata).not.toHaveProperty("platformMessageIds");
	});
});
