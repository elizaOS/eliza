/**
 * Manager-level crash-simulation tests for the durable turn / outbox state
 * machine (charter rows D4/D5). They drive the real MessageManager against a
 * durable in-memory store shared across "process restarts" (fresh manager +
 * fresh service instances reusing the same runtime store), with Discord network
 * objects stubbed but the real memory ordering preserved.
 *
 * The four mandated cases:
 *   (a) crash AFTER inbound persist BEFORE dispatch -> resume replies once
 *   (b) crash AFTER dispatch BEFORE reply record   -> resume replies once
 *   (c) redelivery AFTER REPLIED                    -> no-op (no second reply)
 *   (d) bounded retry exhaustion                    -> terminal FAILED, no drop
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
import {
	type DiscordTurnRuntime,
	discordTurnId,
	loadDiscordTurn,
} from "../turn-state.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const AUTHOR_ID = "555000111222333444";
const CHANNEL_ID = "777000000000000000";
const CLIENT_ID = "888000000000000000";

interface Sent {
	content?: string;
}

/**
 * Durable store that survives "restarts": we build new managers/services but
 * keep this same runtime so persisted memories (inbound, reply, and turn
 * records) carry across the simulated crash boundary.
 */
interface DurableHarness {
	runtime: ICompatRuntime;
	memoriesById: Map<string, Memory>;
	memoriesByRoom: Map<string, Memory[]>;
	sends: Sent[];
	handleCalls: () => number;
	/** Inject a crash mode into the next handleMessage generation. */
	setCrashMode: (mode: CrashMode) => void;
}

type CrashMode =
	| "none"
	/** persist inbound, then throw before invoking the reply callback. */
	| "after-persist-before-reply"
	/** throw before persisting inbound (pre-durable-claim, must stay retryable). */
	| "before-persist";

function roomIdFor(channelId: string): UUID {
	return createUniqueUuid({ agentId: AGENT_ID } as ICompatRuntime, channelId);
}

function makeDurableHarness(): DurableHarness {
	const memoriesById = new Map<string, Memory>();
	const memoriesByRoom = new Map<string, Memory[]>();
	const sends: Sent[] = [];
	let handleCalls = 0;
	let crashMode: CrashMode = "none";

	const indexMemory = (memory: Memory, id: UUID, tableName: string) => {
		const stored = { ...memory, id };
		memoriesById.set(id, stored);
		if (tableName === "messages") {
			const list = memoriesByRoom.get(memory.roomId) ?? [];
			list.unshift(stored);
			memoriesByRoom.set(memory.roomId, list);
		}
	};

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
		getMemoryById: vi.fn(async (id: UUID) => memoriesById.get(id) ?? null),
		createMemory: vi.fn(
			async (memory: Memory, tableName = "messages", _unique?: boolean) => {
				const id =
					memory.id ??
					(createUniqueUuid(runtime as ICompatRuntime, randomUUID()) as UUID);
				indexMemory(memory, id, tableName);
				return id;
			},
		),
		upsertMemory: vi.fn(async (memory: Memory, tableName: string) => {
			const id =
				memory.id ??
				(createUniqueUuid(runtime as ICompatRuntime, randomUUID()) as UUID);
			indexMemory(memory, id, tableName);
		}),
		getMemories: vi.fn(async (params: { roomId?: UUID; tableName: string }) => {
			if (params.tableName !== "messages" || !params.roomId) return [];
			return memoriesByRoom.get(params.roomId) ?? [];
		}),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				handleCalls += 1;
				if (crashMode === "before-persist") {
					crashMode = "none";
					throw new Error("generation failed before inbound persistence");
				}
				// Persist the inbound memory (durable claim point).
				if (message.id && !memoriesById.has(message.id)) {
					indexMemory(message, message.id, "messages");
				}
				if (crashMode === "after-persist-before-reply") {
					crashMode = "none";
					throw new Error("crash after inbound persist, before reply");
				}
				await callback({ text: "one durable reply", source: "discord" });
			},
		},
		emitEvent: vi.fn(),
	} as unknown as ICompatRuntime;

	return {
		runtime,
		memoriesById,
		memoriesByRoom,
		sends,
		handleCalls: () => handleCalls,
		setCrashMode: (mode) => {
			crashMode = mode;
		},
	};
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
		roomId: roomIdFor(CHANNEL_ID),
		content: { text: "hello", source: "discord" },
	};
}

function makeDiscordService(
	client: unknown,
): IDiscordService & { buildMemoryFromMessage: ReturnType<typeof vi.fn> } {
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
		buildMemoryFromMessage: vi.fn(async (message: DiscordMessage) =>
			makeInboundMemory(message.id),
		),
	} as unknown as IDiscordService & {
		buildMemoryFromMessage: ReturnType<typeof vi.fn>;
	};
}

function makeInbound(channel: unknown, messageId: string): DiscordMessage {
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

/** Simulate a process restart by building a fresh manager on the same runtime. */
function restartManager(harness: DurableHarness): MessageManager {
	const service = makeDiscordService({ user: { id: CLIENT_ID } });
	return new MessageManager(service, harness.runtime);
}

/**
 * Count only substantive replies. When generation crashes the manager also
 * emits a short "please retry" failure reply; that is an expected transient
 * notice, not the durable answer, and must not be conflated with the real reply.
 */
function realReplies(harness: DurableHarness): number {
	return harness.sends.filter((s) => s.content === "one durable reply").length;
}

async function turnState(
	harness: DurableHarness,
	messageId: string,
): Promise<string | undefined> {
	const record = await loadDiscordTurn(
		harness.runtime as unknown as DiscordTurnRuntime,
		messageId,
	);
	return record?.state;
}

describe("Discord durable turn / outbox state machine", () => {
	it("(a) crash after inbound persist before dispatch: redelivery resumes and replies exactly once", async () => {
		const messageId = "666000000000001000";
		const harness = makeDurableHarness();
		const channel = makeDmChannel(harness.sends);

		// First delivery crashes after inbound persist, before the reply callback.
		harness.setCrashMode("after-persist-before-reply");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);

		// Inbound persisted, no substantive reply yet, turn not terminal.
		expect(realReplies(harness)).toBe(0);
		expect(
			harness.memoriesById.has(makeInboundMemory(messageId).id as string),
		).toBe(true);
		expect(await turnState(harness, messageId)).not.toBe("REPLIED");

		// Redelivery after "restart" resumes and delivers the reply.
		harness.setCrashMode("none");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);

		expect(realReplies(harness)).toBe(1);
		expect(await turnState(harness, messageId)).toBe("REPLIED");

		// A further redelivery is a genuine no-op.
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(realReplies(harness)).toBe(1);
	});

	it("(b) crash after dispatch before reply record: redelivery replies once, no double send", async () => {
		const messageId = "666000000000001001";
		const harness = makeDurableHarness();
		const channel = makeDmChannel(harness.sends);

		// The dispatch mark is written durably before generation; here generation
		// crashes after inbound persist (so the turn advanced to DISPATCHED and
		// attempts incremented) but before any reply memory was recorded.
		harness.setCrashMode("after-persist-before-reply");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(await turnState(harness, messageId)).toBe("DISPATCHED");
		expect(realReplies(harness)).toBe(0);

		harness.setCrashMode("none");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(realReplies(harness)).toBe(1);
		expect(await turnState(harness, messageId)).toBe("REPLIED");
	});

	it("(b2) reconcile: a reply memory already delivered before the crash is NOT resent", async () => {
		const messageId = "666000000000001002";
		const harness = makeDurableHarness();
		const channel = makeDmChannel(harness.sends);

		// Normal first delivery: reply lands and turn goes REPLIED.
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(realReplies(harness)).toBe(1);
		expect(await turnState(harness, messageId)).toBe("REPLIED");

		// Force the turn back to DISPATCHED to simulate a crash that lost the
		// REPLIED stamp AFTER the reply memory was already durably written.
		const turnId = discordTurnId({ agentId: AGENT_ID }, messageId);
		const rec = harness.memoriesById.get(turnId);
		if (rec?.content && typeof rec.content === "object") {
			(rec.content as { data?: Record<string, unknown> }).data = {
				...((rec.content as { data?: Record<string, unknown> }).data ?? {}),
				state: "DISPATCHED",
			};
		}
		expect(await turnState(harness, messageId)).toBe("DISPATCHED");

		// Redelivery must reconcile from the existing reply memory: no resend.
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(realReplies(harness)).toBe(1);
		expect(await turnState(harness, messageId)).toBe("REPLIED");
	});

	it("(c) redelivery after REPLIED is a no-op with no second reply", async () => {
		const messageId = "666000000000001003";
		const harness = makeDurableHarness();
		const channel = makeDmChannel(harness.sends);

		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(realReplies(harness)).toBe(1);
		expect(await turnState(harness, messageId)).toBe("REPLIED");

		// Same-process duplicate and post-restart duplicate: both no-op.
		const manager = restartManager(harness);
		await manager.handleMessage(makeInbound(channel, messageId));
		await manager.handleMessage(makeInbound(channel, messageId));
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);

		expect(realReplies(harness)).toBe(1);
		expect(harness.handleCalls()).toBe(1);
	});

	it("(d) bounded retry exhaustion drives a terminal FAILED with no silent drop", async () => {
		const messageId = "666000000000001004";
		const harness = makeDurableHarness();
		const channel = makeDmChannel(harness.sends);

		// Crash after persist before reply on every attempt up to the bound.
		for (let i = 0; i < 3; i += 1) {
			harness.setCrashMode("after-persist-before-reply");
			await restartManager(harness).handleMessage(
				makeInbound(channel, messageId),
			);
		}
		// Attempts are now at the bound; next redelivery must terminate FAILED.
		harness.setCrashMode("none");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);

		expect(await turnState(harness, messageId)).toBe("FAILED");
		// FAILED is explicit and terminal: no reply was silently dropped without a
		// recorded terminal state, and further redelivery stays a no-op.
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(await turnState(harness, messageId)).toBe("FAILED");
	});

	it("pre-persistence failure (before durable claim) stays retryable (keeps #16696 semantics)", async () => {
		const messageId = "666000000000001005";
		const harness = makeDurableHarness();
		const channel = makeDmChannel(harness.sends);

		harness.setCrashMode("before-persist");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		// Nothing persisted, no substantive reply, retry must still work.
		expect(realReplies(harness)).toBe(0);
		expect(
			harness.memoriesById.has(makeInboundMemory(messageId).id as string),
		).toBe(false);

		harness.setCrashMode("none");
		await restartManager(harness).handleMessage(
			makeInbound(channel, messageId),
		);
		expect(realReplies(harness)).toBe(1);
		expect(await turnState(harness, messageId)).toBe("REPLIED");
	});
});
