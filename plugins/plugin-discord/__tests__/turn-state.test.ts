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
		const claim = await claimDiscordTurn(store.runtime, "msg-1");
		expect(claim.created).toBe(true);
		expect(claim.record.state).toBe("RECEIVED");
		expect(claim.record.attempts).toBe(0);

		const reloaded = await loadDiscordTurn(store.runtime, "msg-1");
		expect(reloaded?.state).toBe("RECEIVED");

		const second = await claimDiscordTurn(store.runtime, "msg-1");
		expect(second.created).toBe(false);
		expect(second.record.state).toBe("RECEIVED");
	});

	it("advances RECEIVED -> DISPATCHED (attempt++) -> REPLIED", async () => {
		const store = makeStore();
		const { record } = await claimDiscordTurn(store.runtime, "msg-2");
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
		const { record } = await claimDiscordTurn(store.runtime, "msg-3");
		const failed = await markDiscordTurnFailed(store.runtime, record, "boom");
		expect(failed.state).toBe("FAILED");
		expect(failed.failureReason).toBe("boom");
	});

	it("decideResume: terminal REPLIED/FAILED are no-ops", () => {
		const base: DiscordTurnRecord = {
			id: "x" as UUID,
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
