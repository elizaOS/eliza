/**
 * Discord message edits. Drives the real `MessageManager` (inbound guards,
 * memory build, durable turn records, response callback) against an in-memory
 * store. The stub message service persists the inbound memory the way core
 * does: it wraps the text first, as core's incoming-message security does,
 * then stores the host-bound copy if there is one, else the wrapped message;
 * an existing row must hold the same content, or the turn fails. Rows are
 * stored as JSON, as a real database does, so undefined fields drop out.
 */
import { isDeepStrictEqual } from "node:util";
import type { Content, Memory, UUID } from "@elizaos/core";
import {
	ChannelType,
	createUniqueUuid,
	incomingMessagePersistenceSnapshot,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildMemoryFromMessage } from "../discord-history.ts";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const BOT_USER_ID = "888000000000000000";
const AUTHOR_ID = "555000111222333444";
const MESSAGE_ID = "666000000000000000";
const noop = () => {};
const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function makeHarness(replies: Array<string | null>) {
	const rows = new Map<string, { memory: Memory; table: string }>();
	const turns: Content[] = [];
	const sends: string[] = [];
	/** Replies already sent when each turn started: what its history can show. */
	const sendsBeforeTurn: number[] = [];
	const errors: string[] = [];
	let turnStarted: () => void = noop;
	let turnGate: Promise<void> | undefined;

	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		getSetting: () => undefined,
		getService: () => null,
		ensureConnection: async () => {},
		getRoom: async (id: UUID) => ({ id, type: ChannelType.DM }),
		getWorld: async () => null,
		getParticipantsForRoom: async () => [
			createUniqueUuid({ agentId: AGENT_ID } as never, AUTHOR_ID),
			AGENT_ID,
		],
		reportError: (scope: string, error: unknown) => {
			errors.push(
				`${scope}: ${error instanceof Error ? error.message : error}`,
			);
		},
		getMemoryById: async (id: UUID) =>
			structuredClone(rows.get(id)?.memory) ?? null,
		createMemory: async (memory: Memory, table: string) => {
			rows.set(memory.id as string, {
				memory: asStored(memory),
				table,
			});
			return memory.id;
		},
		updateMemory: async (patch: Partial<Memory> & { id: UUID }) => {
			const row = rows.get(patch.id);
			if (!row) return false;
			row.memory = asStored({ ...row.memory, ...patch });
			return true;
		},
		getMemories: async (params: { roomId: UUID; tableName: string }) =>
			[...rows.values()]
				.filter(
					(row) =>
						row.table === params.tableName &&
						row.memory.roomId === params.roomId,
				)
				.map((row) => structuredClone(row.memory)),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				message.content.text = `<external>${message.content.text}</external>`;
				const persistable =
					incomingMessagePersistenceSnapshot(message) ?? message;
				const stored = rows.get(message.id as string)?.memory;
				if (stored && !isDeepStrictEqual(stored.content, persistable.content)) {
					throw new Error("MESSAGE_CONTENT_PUBLICATION_CONFLICT");
				}
				if (!stored) {
					rows.set(message.id as string, {
						memory: asStored(persistable),
						table: "messages",
					});
				}
				const reply = replies[turns.length];
				turns.push(structuredClone(message.content));
				sendsBeforeTurn.push(sends.length);
				turnStarted();
				await turnGate;
				if (reply) await callback({ text: reply, channelType: "DM" });
			},
		},
	} as unknown as ICompatRuntime;

	const dmUser = {
		id: AUTHOR_ID,
		send: async (options: { content?: string }) => {
			sends.push(options.content ?? "");
			return {
				id: `99000000000000000${sends.length}`,
				content: options.content ?? "",
				url: `https://discord.com/channels/@me/1/9900${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
	};
	const client = {
		user: { id: BOT_USER_ID },
		users: { fetch: async () => dmUser },
	};
	const service = {
		client,
		accountId: "default",
		runtime,
		messageManager: undefined,
		resolveDiscordEntityId: (userId: string) =>
			createUniqueUuid(runtime as never, userId),
		isOwnerAliasedDiscordUser: () => false,
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: false,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
		buildMemoryFromMessage: (
			message: DiscordMessage,
			options: Parameters<typeof buildMemoryFromMessage>[2],
		) => buildMemoryFromMessage(service as never, message, options),
	};
	const manager = new MessageManager(
		service as unknown as IDiscordService,
		runtime,
	);
	return {
		manager,
		rows,
		turns,
		sends,
		sendsBeforeTurn,
		errors,
		stored: () => rows.get(createUniqueUuid(runtime as never, MESSAGE_ID)),
		/** Holds every turn inside the message service until released. */
		holdTurns() {
			let release = noop;
			turnGate = new Promise((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				turnStarted = resolve;
			});
			return { started, release };
		},
	};
}

const channel = {
	id: "777000000000000000",
	type: DiscordChannelType.DM,
	isThread: () => false,
};

function makeMessage(
	content: string,
	overrides: Record<string, unknown> = {},
): DiscordMessage {
	return {
		id: MESSAGE_ID,
		content,
		createdTimestamp: Date.UTC(2026, 9, 20, 20, 57, 16),
		editedTimestamp: null,
		author: {
			id: AUTHOR_ID,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
			displayAvatarURL: () => "",
		},
		member: null,
		channel,
		channelId: channel.id,
		guild: undefined,
		interaction: null,
		reference: undefined,
		url: `https://discord.com/channels/@me/${channel.id}/${MESSAGE_ID}`,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: new Map(), repliedUser: undefined },
		partial: false,
		...overrides,
	} as unknown as DiscordMessage;
}

/** What discord.js does to the cached message when the author edits it. */
function edit(message: DiscordMessage, content: string, at: number) {
	Object.assign(message, { content, editedTimestamp: at });
	return message;
}

const EDITED_AT = Date.UTC(2026, 9, 20, 20, 57, 23);

describe("Discord message edits", () => {
	it("updates the stored memory and runs one more turn when the agent had replied", async () => {
		const h = makeHarness(["that link is doubled", "looks good now"]);
		const message = makeMessage("hihi");
		await h.manager.handleMessage(message);
		expect(h.sends).toEqual(["that link is doubled"]);

		await h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));

		const stored = h.stored()?.memory.content;
		expect(stored?.currentMessageText).toBe("hi");
		expect(stored?.editedAt).toBe(new Date(EDITED_AT).toISOString());
		expect(h.turns.map((turn) => turn.currentMessageText)).toEqual([
			"hihi",
			"hi",
		]);
		expect(h.turns[1].editedAt).toBe(new Date(EDITED_AT).toISOString());
		expect(h.sends).toEqual(["that link is doubled", "looks good now"]);

		// Discord redelivers the same edit: no second edit turn.
		await h.manager.handleMessageEdit(message);
		expect(h.turns).toHaveLength(2);
		expect(h.sends).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it("only updates memory when the agent did not reply to the original", async () => {
		const h = makeHarness([null, "should not be sent"]);
		const message = makeMessage("hihi");
		await h.manager.handleMessage(message);

		await h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));

		expect(h.stored()?.memory.content.currentMessageText).toBe("hi");
		expect(h.turns).toHaveLength(1);
		expect(h.sends).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("ignores embed unfurls, the agent's own messages, and messages it never stored", async () => {
		const h = makeHarness(["first", "second", "third"]);
		const message = makeMessage("see this");
		await h.manager.handleMessage(message);
		const before = structuredClone(h.stored()?.memory);

		// Unfurl: embeds change, editedTimestamp does not.
		Object.assign(message, {
			embeds: [{ title: "Preview", description: "card" }],
		});
		await h.manager.handleMessageEdit(message);
		expect(h.stored()?.memory).toEqual(before);

		await h.manager.handleMessageEdit(
			makeMessage("bot text", {
				id: "666000000000000001",
				editedTimestamp: EDITED_AT,
				author: { id: BOT_USER_ID, bot: true, username: "eliza" },
			}),
		);
		await h.manager.handleMessageEdit(
			makeMessage("never seen", {
				id: "666000000000000002",
				editedTimestamp: EDITED_AT,
			}),
		);

		expect(h.turns).toHaveLength(1);
		expect(h.sends).toEqual(["first"]);
		expect(
			h.rows.has(
				createUniqueUuid({ agentId: AGENT_ID } as never, "666000000000000002"),
			),
		).toBe(false);
	});

	it("ignores edits by bots, even of a stored message", async () => {
		const h = makeHarness(["first", "second"]);
		const message = makeMessage("progress 10%", {
			author: { id: "444000000000000000", bot: true, username: "other" },
		});
		const id = createUniqueUuid({ agentId: AGENT_ID } as never, MESSAGE_ID);
		h.rows.set(id, {
			memory: { id, content: { text: "progress 10%" } } as Memory,
			table: "messages",
		});

		await h.manager.handleMessageEdit(edit(message, "progress 20%", EDITED_AT));

		expect(h.stored()?.memory.content).toEqual({ text: "progress 10%" });
		expect(h.turns).toHaveLength(0);
		expect(h.errors).toEqual([]);
	});

	it("leaves a coalesced batch memory alone when its anchor is edited", async () => {
		const h = makeHarness(["batch reply", "should not be sent"]);
		const message = makeMessage("hihi");
		await h.manager.handleMessage(message);
		const row = h.stored();
		if (!row) throw new Error("inbound memory not stored");
		row.memory.metadata = {
			...row.memory.metadata,
			coalescedDiscordMessageIds: [MESSAGE_ID, "666000000000000009"],
		} as Memory["metadata"];
		const before = structuredClone(row.memory);

		await h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));

		expect(h.stored()?.memory).toEqual(before);
		expect(h.turns).toHaveLength(1);
		expect(h.sends).toEqual(["batch reply"]);
		expect(h.errors).toEqual([]);
	});

	it("fetches an uncached (partial) update before handling it", async () => {
		const h = makeHarness(["partial first", "partial second"]);
		const message = makeMessage("hihi");
		await h.manager.handleMessage(message);

		const fetched = makeMessage("hi", { editedTimestamp: EDITED_AT });
		await h.manager.handleMessageEdit({
			id: MESSAGE_ID,
			partial: true,
			editedTimestamp: EDITED_AT,
			fetch: async () => fetched,
		} as never);

		expect(h.turns.map((turn) => turn.currentMessageText)).toEqual([
			"hihi",
			"hi",
		]);
		expect(h.sends).toEqual(["partial first", "partial second"]);
	});

	it("drops an older edit whose fetch finishes after a newer edit was stored", async () => {
		const h = makeHarness(["first reply", "second reply"]);
		const message = makeMessage("hihi");
		await h.manager.handleMessage(message);
		await h.manager.handleMessageEdit(
			edit(message, "second edit", EDITED_AT + 1000),
		);

		await h.manager.handleMessageEdit({
			id: MESSAGE_ID,
			partial: true,
			editedTimestamp: EDITED_AT,
			fetch: async () =>
				makeMessage("first edit", { editedTimestamp: EDITED_AT }),
		} as never);

		expect(h.stored()?.memory.content.currentMessageText).toBe("second edit");
		expect(h.turns.map((turn) => turn.currentMessageText)).toEqual([
			"hihi",
			"second edit",
		]);
	});

	it("waits for a still-running original turn and answers the edit once", async () => {
		const h = makeHarness(["doubled again", "fixed now"]);
		const message = makeMessage("hihi");
		const { started, release } = h.holdTurns();
		const original = h.manager.handleMessage(message);
		await started;

		edit(message, "hi", EDITED_AT);
		// The edit and a gateway redelivery of it land while the turn runs.
		const edits = [
			h.manager.handleMessageEdit(message),
			h.manager.handleMessageEdit(message),
		];
		// Give an unserialized edit time to reach the model before the
		// original turn finishes.
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([original, ...edits]);

		expect(h.turns.map((turn) => turn.currentMessageText)).toEqual([
			"hihi",
			"hi",
		]);
		// The edit turn starts only after the original reply went out.
		expect(h.sendsBeforeTurn).toEqual([0, 1]);
		expect(h.sends).toEqual(["doubled again", "fixed now"]);
		expect(h.errors).toEqual([]);
	});
});
