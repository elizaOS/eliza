/**
 * Pure unit tests for the durable turn / outbox state machine (turn-state.ts).
 *
 * These exercise the state transitions and the resume decision function in
 * isolation with a tiny in-memory store, independent of the Discord manager.
 * The manager-level crash-simulation cases live in
 * messages-durable-turn.test.ts.
 */
import { randomUUID } from "node:crypto";
import { createUniqueUuid, type Memory, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	claimDiscordTurn,
	DISCORD_TURN_MAX_ATTEMPTS,
	DISCORD_TURN_TABLE,
	type DiscordTurnRecord,
	type DiscordTurnRuntime,
	decideResume,
	discordTurnId,
	findDeliveredReply,
	isTerminalTurnState,
	loadDiscordTurn,
	markDiscordTurnDispatched,
	markDiscordTurnFailed,
	markDiscordTurnReplied,
} from "../turn-state.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const ENTITY_ID = "11111111-2222-3333-4444-555555555555" as UUID;
const ROOM_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa" as UUID;
const WORLD_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" as UUID;
const CONVERSATION = {
	entityId: ENTITY_ID,
	roomId: ROOM_ID,
	worldId: WORLD_ID,
};

interface Store {
	runtime: DiscordTurnRuntime;
	byId: Map<string, Memory>;
	byRoom: Map<string, Memory[]>;
}

function makeStore(): Store {
	const byId = new Map<string, Memory>();
	const byRoom = new Map<string, Memory[]>();
	const runtime = {
		agentId: AGENT_ID,
		getMemoryById: async (id: UUID) => byId.get(id) ?? null,
		createMemory: async (memory: Memory, tableName: string) => {
			const id = memory.id ?? (randomUUID() as UUID);
			byId.set(id, { ...memory, id });
			if (tableName === "messages") {
				const list = byRoom.get(memory.roomId) ?? [];
				list.unshift({ ...memory, id });
				byRoom.set(memory.roomId, list);
			}
			return id;
		},
		getMemories: async (params: { roomId?: UUID; tableName: string }) => {
			if (params.tableName !== "messages" || !params.roomId) return [];
			return byRoom.get(params.roomId) ?? [];
		},
	} as unknown as DiscordTurnRuntime;
	return { runtime, byId, byRoom };
}

function seedReplyMemory(
	store: Store,
	roomId: UUID,
	inboundMemoryId: UUID,
	replyMessageId: string,
): void {
	const memory = {
		id: createUniqueUuid({ agentId: AGENT_ID }, replyMessageId) as UUID,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId,
		content: { text: "reply", source: "discord", inReplyTo: inboundMemoryId },
		metadata: { platformMessageId: replyMessageId },
	} as Memory;
	store.byId.set(memory.id as string, memory);
	const list = store.byRoom.get(roomId) ?? [];
	list.unshift(memory);
	store.byRoom.set(roomId, list);
}

describe("durable turn state machine", () => {
	it("uses the same table constant and derives a stable turn id", () => {
		expect(DISCORD_TURN_TABLE).toBe("discord_turns");
		const a = discordTurnId({ agentId: AGENT_ID }, "123");
		const b = discordTurnId({ agentId: AGENT_ID }, "123");
		const c = discordTurnId({ agentId: AGENT_ID }, "456");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it("marks REPLIED and FAILED as terminal, RECEIVED/DISPATCHED as resumable", () => {
		expect(isTerminalTurnState("REPLIED")).toBe(true);
		expect(isTerminalTurnState("FAILED")).toBe(true);
		expect(isTerminalTurnState("RECEIVED")).toBe(false);
		expect(isTerminalTurnState("DISPATCHED")).toBe(false);
	});

	it("claims a fresh turn as RECEIVED then reloads the same record", async () => {
		const store = makeStore();
		const claim = await claimDiscordTurn(store.runtime, "msg-1", CONVERSATION);
		expect(claim.created).toBe(true);
		expect(claim.record.state).toBe("RECEIVED");
		expect(claim.record.attempts).toBe(0);
		expect(store.byId.get(claim.record.id)).toMatchObject(CONVERSATION);

		const reloaded = await loadDiscordTurn(store.runtime, "msg-1");
		expect(reloaded?.state).toBe("RECEIVED");

		const second = await claimDiscordTurn(store.runtime, "msg-1", CONVERSATION);
		expect(second.created).toBe(false);
		expect(second.record.state).toBe("RECEIVED");
	});

	it("advances RECEIVED -> DISPATCHED (attempt++) -> REPLIED", async () => {
		const store = makeStore();
		const { record } = await claimDiscordTurn(
			store.runtime,
			"msg-2",
			CONVERSATION,
		);
		const dispatched = await markDiscordTurnDispatched(store.runtime, record);
		expect(dispatched.state).toBe("DISPATCHED");
		expect(dispatched.attempts).toBe(1);
		const replied = await markDiscordTurnReplied(
			store.runtime,
			dispatched,
			"reply-99",
		);
		expect(replied.state).toBe("REPLIED");
		expect(replied.replyMessageId).toBe("reply-99");
		const reloaded = await loadDiscordTurn(store.runtime, "msg-2");
		expect(reloaded?.state).toBe("REPLIED");
		expect(reloaded?.attempts).toBe(1);
	});

	it("records a terminal FAILED with a reason", async () => {
		const store = makeStore();
		const { record } = await claimDiscordTurn(
			store.runtime,
			"msg-3",
			CONVERSATION,
		);
		const failed = await markDiscordTurnFailed(store.runtime, record, "boom");
		expect(failed.state).toBe("FAILED");
		expect(failed.failureReason).toBe("boom");
	});

	it("decideResume: terminal REPLIED/FAILED are no-ops", () => {
		const base: DiscordTurnRecord = {
			id: "x" as UUID,
			...CONVERSATION,
			platformMessageId: "m",
			state: "REPLIED",
			attempts: 1,
			createdAt: 0,
			updatedAt: 0,
		};
		expect(decideResume(base, null)).toEqual({
			action: "noop",
			reason: "replied",
		});
		expect(decideResume({ ...base, state: "FAILED" }, null)).toEqual({
			action: "noop",
			reason: "failed",
		});
	});

	it("decideResume: existing delivered reply reconciles to REPLIED without resend", () => {
		const record: DiscordTurnRecord = {
			id: "x" as UUID,
			...CONVERSATION,
			platformMessageId: "m",
			state: "DISPATCHED",
			attempts: 1,
			createdAt: 0,
			updatedAt: 0,
		};
		expect(decideResume(record, "reply-77")).toEqual({
			action: "reconciled-replied",
			replyMessageId: "reply-77",
		});
	});

	it("decideResume: resumes when no reply exists and budget remains", () => {
		const record: DiscordTurnRecord = {
			id: "x" as UUID,
			...CONVERSATION,
			platformMessageId: "m",
			state: "DISPATCHED",
			attempts: 1,
			createdAt: 0,
			updatedAt: 0,
		};
		const decision = decideResume(record, null);
		expect(decision.action).toBe("resume");
	});

	it("decideResume: exhausts when attempts reach the bound with no reply", () => {
		const record: DiscordTurnRecord = {
			id: "x" as UUID,
			...CONVERSATION,
			platformMessageId: "m",
			state: "DISPATCHED",
			attempts: DISCORD_TURN_MAX_ATTEMPTS,
			createdAt: 0,
			updatedAt: 0,
		};
		const decision = decideResume(record, null);
		expect(decision.action).toBe("exhausted");
	});

	it("findDeliveredReply matches a reply memory by inReplyTo + agent author", async () => {
		const store = makeStore();
		const roomId = "room-1" as UUID;
		const inboundMemoryId = "inbound-1" as UUID;
		expect(
			await findDeliveredReply(store.runtime, roomId, inboundMemoryId),
		).toBeNull();
		seedReplyMemory(store, roomId, inboundMemoryId, "reply-abc");
		expect(
			await findDeliveredReply(store.runtime, roomId, inboundMemoryId),
		).toBe("reply-abc");
	});

	it("findDeliveredReply ignores replies to a different inbound", async () => {
		const store = makeStore();
		const roomId = "room-2" as UUID;
		seedReplyMemory(store, roomId, "other-inbound" as UUID, "reply-xyz");
		expect(
			await findDeliveredReply(store.runtime, roomId, "inbound-2" as UUID),
		).toBeNull();
	});
});

/**
 * Regression guard for the Gate-3 persistence blocker (2026-07-22).
 *
 * The original durable-turn write path stamped every turn memory with
 * `roomId = <synthetic turn id>` and NO `worldId`. On PGlite/Postgres the
 * `memories` INSERT then referenced a room/world that was never
 * ensureRoom/ensureWorld'd for a channel created *after* connect, so the
 * INSERT threw an FK / NOT-NULL violation and EVERY ingested Discord message
 * failed to persist (Gate-3 D1-D5 all blocked).
 *
 * The permissive `makeStore()` above cannot catch that class of bug because it
 * accepts any INSERT regardless of scope. This suite models the store the way
 * the real backend does: a `discord_turns` row is only accepted when its
 * `roomId` and `worldId` reference rows the runtime has already ensured. It
 * asserts (a) the fixed path persists using the real conversation scope, and
 * (b) the pre-fix behaviour (synthetic/unensured room, missing world) is
 * rejected -- so a future regression that drops the scope fails loudly here.
 */
describe("durable turn persistence is FK-safe for post-connect channels", () => {
	interface FkStore {
		runtime: DiscordTurnRuntime;
		byId: Map<string, Memory>;
		ensuredWorlds: Set<string>;
		ensuredRooms: Set<string>;
		rejections: string[];
	}

	/**
	 * A store whose `createMemory` enforces the same referential integrity the
	 * live `memories` table does: a `discord_turns` row must carry a non-null
	 * `worldId` and a `roomId`, and both must have been ensured first. This is
	 * the check the permissive mock lacks and the check the real DB applies.
	 */
	function makeFkStore(): FkStore {
		const byId = new Map<string, Memory>();
		const ensuredWorlds = new Set<string>();
		const ensuredRooms = new Set<string>();
		const rejections: string[] = [];
		const runtime = {
			agentId: AGENT_ID,
			getMemoryById: async (id: UUID) => byId.get(id) ?? null,
			getMemories: async () => [],
			createMemory: async (memory: Memory, tableName: string) => {
				if (tableName === DISCORD_TURN_TABLE) {
					if (!memory.worldId) {
						const msg = `NOT NULL violation: memories.world_id (turn ${memory.id})`;
						rejections.push(msg);
						throw new Error(msg);
					}
					if (!ensuredWorlds.has(memory.worldId)) {
						const msg = `FK violation: memories.world_id -> worlds (${memory.worldId} not ensured)`;
						rejections.push(msg);
						throw new Error(msg);
					}
					if (!memory.roomId || !ensuredRooms.has(memory.roomId)) {
						const msg = `FK violation: memories.room_id -> rooms (${memory.roomId} not ensured)`;
						rejections.push(msg);
						throw new Error(msg);
					}
				}
				const id = memory.id ?? (randomUUID() as UUID);
				byId.set(id, { ...memory, id });
				return id;
			},
		} as unknown as DiscordTurnRuntime;
		return { runtime, byId, ensuredWorlds, ensuredRooms, rejections };
	}

	it("persists the RECEIVED turn using the ensured conversation scope (no FK error)", async () => {
		const store = makeFkStore();
		// The connector's ensureConnection() ran for this post-connect channel
		// before the turn is claimed; model that the world+room now exist.
		store.ensuredWorlds.add(WORLD_ID);
		store.ensuredRooms.add(ROOM_ID);

		const claim = await claimDiscordTurn(store.runtime, "post-connect-1", {
			entityId: ENTITY_ID,
			roomId: ROOM_ID,
			worldId: WORLD_ID,
		});

		expect(claim.created).toBe(true);
		expect(store.rejections).toEqual([]);
		const persisted = store.byId.get(claim.record.id);
		expect(persisted).toBeDefined();
		// The turn memory must be scoped to the REAL channel room + world, not the
		// synthetic turn id, otherwise the live INSERT would FK-fail.
		expect(persisted?.roomId).toBe(ROOM_ID);
		expect(persisted?.worldId).toBe(WORLD_ID);
		expect(persisted?.entityId).toBe(ENTITY_ID);
		expect(persisted?.roomId).not.toBe(claim.record.id);

		// And the record round-trips through decode with its scope intact.
		const reloaded = await loadDiscordTurn(store.runtime, "post-connect-1");
		expect(reloaded?.roomId).toBe(ROOM_ID);
		expect(reloaded?.worldId).toBe(WORLD_ID);
	});

	it("reproduces the pre-fix blocker: an unscoped turn INSERT is rejected", async () => {
		const store = makeFkStore();
		// Same post-connect channel is ensured...
		store.ensuredWorlds.add(WORLD_ID);
		store.ensuredRooms.add(ROOM_ID);

		// ...but simulate the OLD write path: a turn memory scoped to the
		// synthetic turn id with no world (roomId == id, worldId == undefined).
		const syntheticTurnId = discordTurnId({ agentId: AGENT_ID }, "pre-fix-1");
		const legacyTurnMemory = {
			id: syntheticTurnId,
			entityId: AGENT_ID,
			agentId: AGENT_ID,
			roomId: syntheticTurnId, // room == turn id, never ensured
			// worldId intentionally omitted -> SQL default/NULL
			content: {
				text: `discord-turn pre-fix-1 RECEIVED`,
				source: "discord-turn",
				data: {
					platformMessageId: "pre-fix-1",
					state: "RECEIVED",
					attempts: 0,
				},
			},
			createdAt: Date.now(),
		} as Memory;

		await expect(
			store.runtime.createMemory(legacyTurnMemory, DISCORD_TURN_TABLE, true),
		).rejects.toThrow(/NOT NULL violation.*world_id/);
		expect(store.rejections.length).toBe(1);
	});

	it("rejects a turn whose world was never ensured (post-connect FK path)", async () => {
		const store = makeFkStore();
		// Room ensured but the world is NOT -> mirrors a channel created after
		// connect whose world bootstrap was skipped.
		store.ensuredRooms.add(ROOM_ID);

		await expect(
			claimDiscordTurn(store.runtime, "post-connect-2", {
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				worldId: WORLD_ID,
			}),
		).rejects.toThrow(/FK violation.*world_id/);
		expect(store.byId.size).toBe(0);
	});
});
