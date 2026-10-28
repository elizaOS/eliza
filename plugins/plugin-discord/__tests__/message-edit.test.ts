/**
 * Discord message edits. Drives the real `MessageManager` (inbound guards,
 * memory build, durable turn records, response callback) against an in-memory
 * store. The stub message service persists the inbound memory the way core
 * does: it wraps the text first, as core's incoming-message security does,
 * then stores the host-bound copy if there is one, else the wrapped message;
 * an existing row must hold the same content, or the turn fails. Rows are
 * stored as JSON, as a real database does, so undefined fields drop out. A
 * held turn ends with the abort reason when its signal fires, as core's does.
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

function makeHarness(
	replies: Array<string | null>,
	{ replyBeforeHold = false, respondBeforeHold = false } = {},
) {
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
				options?: {
					abortSignal?: AbortSignal;
					onResponseDecision?: () => void;
				},
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
				// Core decides to respond (the agent starts typing) before it
				// runs an action or sends a reply.
				if (respondBeforeHold) options?.onResponseDecision?.();
				if (reply && replyBeforeHold) {
					await callback({ text: reply, channelType: "DM" });
				}
				turnStarted();
				const signal = options?.abortSignal;
				await Promise.race([
					turnGate,
					new Promise<void>((resolve) =>
						signal?.addEventListener("abort", () => resolve()),
					),
				]);
				if (signal?.aborted) throw signal.reason;
				if (reply && !replyBeforeHold) {
					await callback({ text: reply, channelType: "DM" });
				}
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
		// The agent sees the text the edit replaced.
		expect(h.turns[1].editedFrom).toBe("hihi");
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
		expect(h.turns[1].editedFrom).toBe("hihi");
	});

	it("tells each later edit the text the previous edit left", async () => {
		const h = makeHarness(["one", "two", "three"]);
		const message = makeMessage("hihi");
		await h.manager.handleMessage(message);
		await h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));
		await h.manager.handleMessageEdit(edit(message, "hey", EDITED_AT + 1000));

		expect(
			h.turns.map((turn) => [turn.currentMessageText, turn.editedFrom]),
		).toEqual([
			["hihi", undefined],
			["hi", "hihi"],
			["hey", "hi"],
		]);
		expect(h.sends).toEqual(["one", "two", "three"]);
		expect(h.errors).toEqual([]);
	});

	it("cancels a still-running original turn that has not replied and answers only the edit", async () => {
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
		expect(h.turns[1].editedFrom).toBe("hihi");
		// The original's reply never goes out; the edit gets the only answer.
		expect(h.sends).toEqual(["fixed now"]);
		expect(h.errors).toEqual([]);
	});

	it("lets a running turn that already replied finish, then answers the edit", async () => {
		const h = makeHarness(["already answered", "answering the edit"], {
			replyBeforeHold: true,
		});
		const message = makeMessage("hihi");
		const { started, release } = h.holdTurns();
		const original = h.manager.handleMessage(message);
		await started;

		const edited = h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([original, edited]);

		expect(h.turns.map((turn) => turn.currentMessageText)).toEqual([
			"hihi",
			"hi",
		]);
		// The edit turn starts only after the original turn finished.
		expect(h.sendsBeforeTurn).toEqual([0, 1]);
		expect(h.sends).toEqual(["already answered", "answering the edit"]);
		expect(h.errors).toEqual([]);
	});

	it("lets a running turn that is already typing finish, then answers the edit", async () => {
		const h = makeHarness(["reminder set", "moved it to 6"], {
			respondBeforeHold: true,
		});
		const message = makeMessage("remind me at 5");
		const { started, release } = h.holdTurns();
		const original = h.manager.handleMessage(message);
		await started;

		const edited = h.manager.handleMessageEdit(
			edit(message, "remind me at 6", EDITED_AT),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([original, edited]);

		// A typing turn may be running an action (a reminder here): its reply
		// still goes out, and the edit is answered after it.
		expect(h.sends).toEqual(["reminder set", "moved it to 6"]);
		expect(h.turns[1].editedFrom).toBe("remind me at 5");
		expect(h.errors).toEqual([]);
	});

	it("does not cancel the edit's own turn for an unfurl or redelivery of that edit", async () => {
		const h = makeHarness(["first answer", "edit answer"]);
		const message = makeMessage("check a.example");
		await h.manager.handleMessage(message);

		const { started, release } = h.holdTurns();
		const edited = h.manager.handleMessageEdit(
			edit(message, "check b.example", EDITED_AT),
		);
		await started;
		// Discord repeats the update with the same stamp (an unfurl).
		const unfurl = h.manager.handleMessageEdit(message);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([edited, unfurl]);

		expect(h.sends).toEqual(["first answer", "edit answer"]);
		expect(h.turns).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it("answers a second quick edit after the first edit's turn was cancelled too", async () => {
		const h = makeHarness([null, null, "only the last edit"]);
		const message = makeMessage("hihi");
		const { started, release } = h.holdTurns();
		const original = h.manager.handleMessage(message);
		await started;
		const first = h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));
		// The first edit's turn starts and is held too.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = h.manager.handleMessageEdit(
			edit(message, "hey", EDITED_AT + 1000),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([original, first, second]);

		expect(h.sends).toEqual(["only the last edit"]);
		expect(h.turns.at(-1)?.currentMessageText).toBe("hey");
		expect(h.turns.at(-1)?.editedFrom).toBe("hi");
		expect(h.errors).toEqual([]);
	});

	it("scrubs a secret out of the text an edit replaced", async () => {
		const h = makeHarness(["got it", "ok"]);
		const secret = `sk-ant-api03-${"a".repeat(40)}`;
		const message = makeMessage(`my key is ${secret}`);
		await h.manager.handleMessage(message);
		await h.manager.handleMessageEdit(
			edit(message, "never mind, ignore that", EDITED_AT),
		);

		expect(h.turns[1].editedFrom).not.toContain(secret);
		expect(h.stored()?.memory.content.editedFrom).not.toContain(secret);
	});

	it("does not cancel a turn that folds in recent channel context", async () => {
		const h = makeHarness(["it's sunny in paris", "still sunny"]);
		const anchor = makeMessage("^^");
		// The debouncer hands over the anchor with earlier messages folded in.
		const folded = Object.create(anchor, {
			__discordAddressingContent: {
				value: "[Recent channel context]\nTester: weather in paris?\n\n^^",
			},
		}) as DiscordMessage;
		const { started, release } = h.holdTurns();
		const original = h.manager.handleMessage(folded);
		await started;

		const edited = h.manager.handleMessageEdit(
			edit(anchor, "^^ pls", EDITED_AT),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([original, edited]);

		// The folded question is still answered, then the edit.
		expect(h.sends).toEqual(["it's sunny in paris", "still sunny"]);
		expect(h.errors).toEqual([]);
	});

	it("answers a second edit that lands just after the first edit cancelled the original", async () => {
		const h = makeHarness([null, "answer to hey"]);
		const message = makeMessage("hihi");
		const { started, release } = h.holdTurns();
		const original = h.manager.handleMessage(message);
		await started;
		const first = h.manager.handleMessageEdit(edit(message, "hi", EDITED_AT));
		await original;
		// The cancelled turn is gone and the first edit's turn is starting when
		// discord.js patches the cached message with the second edit.
		const second = h.manager.handleMessageEdit(
			edit(message, "hey", EDITED_AT + 1000),
		);
		release();
		await Promise.all([first, second]);

		expect(h.sends).toEqual(["answer to hey"]);
		expect(h.turns.at(-1)?.currentMessageText).toBe("hey");
		expect(h.errors).toEqual([]);
	});
});
