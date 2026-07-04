/**
 * ROOM action mute hardening: scope=server (world-level mute the inbound gate
 * consults) and durationMinutes persistence (agentMuteUntilIso, consumed by
 * the mute-state due-check). Map-backed runtime; the model gate answers via a
 * stubbed TEXT_SMALL response; assertions read the stores the inbound gate
 * reads, closing the loop from action write to message drop.
 */
import { describe, expect, it } from "vitest";
import { resolveEffectiveMuteState } from "../../../services/message/mute-state";
import type { Room, World } from "../../../types/environment";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index";
import { roomOpAction } from "./room";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const SIBLING_ROOM_ID = "00000000-0000-0000-0000-0000000000d2" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;

function makeRuntime(seed?: {
	states?: Record<string, "FOLLOWED" | "MUTED">;
	rooms?: Room[];
	worlds?: World[];
}) {
	const states = new Map<string, "FOLLOWED" | "MUTED" | null>(
		Object.entries(seed?.states ?? {}),
	);
	const rooms = new Map<string, Room>(
		(seed?.rooms ?? []).map((room) => [room.id, room]),
	);
	const worlds = new Map<string, World>(
		(seed?.worlds ?? []).map((world) => [world.id, world]),
	);
	const memories: Memory[] = [];
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		useModel: async () => "yes",
		createMemory: async (memory: Memory) => {
			memories.push(memory);
			return memory.id;
		},
		getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
			states.get(`${roomId}:${entityId}`) ?? null,
		updateParticipantUserState: async (
			roomId: UUID,
			entityId: UUID,
			state: "FOLLOWED" | "MUTED" | null,
		) => {
			states.set(`${roomId}:${entityId}`, state);
		},
		getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
		updateRoom: async (room: Room) => {
			rooms.set(room.id, room);
		},
		getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
		updateWorld: async (world: World) => {
			worlds.set(world.id, world);
		},
	} as unknown as IAgentRuntime;
	return { runtime, states, rooms, worlds, memories };
}

function room(id: UUID): Room {
	return {
		id,
		name: `room-${id.slice(-2)}`,
		source: "discord",
		type: "GROUP",
		worldId: WORLD_ID,
	} as Room;
}

function world(extra?: Partial<World>): World {
	return { id: WORLD_ID, agentId: AGENT_ID, name: "Cozy Devs", ...extra };
}

function msg(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b1" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, source: "discord" },
	} as Memory;
}

function opts(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

const state = { values: {}, data: {}, text: "" } as State;

describe("ROOM action — timed mute persistence (durationMinutes)", () => {
	it("mute with durationMinutes writes agentMuteUntilIso and returns scheduleAutoUnmuteIso", async () => {
		const { runtime, states, rooms } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world()],
		});
		const before = Date.now();
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this channel for 30 minutes"),
			state,
			opts({ action: "mute", durationMinutes: 30 }),
		);
		expect(result.success).toBe(true);
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
		const untilIso = rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso;
		expect(typeof untilIso).toBe("string");
		const expiry = Date.parse(untilIso as string);
		expect(expiry).toBeGreaterThanOrEqual(before + 29 * 60_000);
		expect(expiry).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
		expect((result.data as Record<string, unknown>).scheduleAutoUnmuteIso).toBe(
			untilIso,
		);
	});

	it("an untimed mute clears a stale expiry; unmute clears state and expiry", async () => {
		const stale = new Date(Date.now() + 5 * 60_000).toISOString();
		const { runtime, states, rooms } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world()],
		});
		rooms.set(ROOM_ID, {
			...room(ROOM_ID),
			metadata: { agentMuteUntilIso: stale },
		});
		await roomOpAction.handler(
			runtime,
			msg("mute this channel"),
			state,
			opts({ action: "mute" }),
		);
		expect(rooms.get(ROOM_ID)?.metadata).not.toHaveProperty(
			"agentMuteUntilIso",
		);
		await roomOpAction.handler(
			runtime,
			msg("unmute this channel"),
			state,
			opts({ action: "unmute" }),
		);
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeNull();
	});
});

describe("ROOM action — scope=server (guild-wide mute)", () => {
	it("mutes the world; a sibling room in the same world then drops via the inbound gate", async () => {
		const { runtime, worlds } = makeRuntime({
			rooms: [room(ROOM_ID), room(SIBLING_ROOM_ID)],
			worlds: [world()],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this whole server"),
			state,
			opts({ action: "mute", scope: "server" }),
		);
		expect(result.success).toBe(true);
		expect((result.data as Record<string, unknown>).scope).toBe("server");
		expect(worlds.get(WORLD_ID)?.metadata?.agentMuteState).toBe("MUTED");
		// The guild mute drops a child channel that has no room-level mute.
		expect(
			await resolveEffectiveMuteState(runtime, {
				roomIds: [SIBLING_ROOM_ID],
			}),
		).toEqual({ muted: true, scope: "server", worldId: WORLD_ID });
	});

	it("timed server mute stores the expiry; unmute clears the world metadata", async () => {
		const { runtime, worlds } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world()],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute the server for an hour"),
			state,
			opts({ action: "mute", scope: "server", durationMinutes: 60 }),
		);
		expect(result.success).toBe(true);
		expect(typeof worlds.get(WORLD_ID)?.metadata?.agentMuteUntilIso).toBe(
			"string",
		);
		const unmuted = await roomOpAction.handler(
			runtime,
			msg("unmute the server"),
			state,
			opts({ action: "unmute", scope: "server" }),
		);
		expect(unmuted.success).toBe(true);
		const metadata = worlds.get(WORLD_ID)?.metadata ?? {};
		expect(metadata).not.toHaveProperty("agentMuteState");
		expect(metadata).not.toHaveProperty("agentMuteUntilIso");
	});

	it("preconditions: muting an already-muted server fails; scope=server rejects follow", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
		});
		const again = await roomOpAction.handler(
			runtime,
			msg("mute the server"),
			state,
			opts({ action: "mute", scope: "server" }),
		);
		expect(again.success).toBe(false);
		expect((again.values as Record<string, unknown>).error).toBe(
			"ROOM_MUTE_PRECONDITION_FAILED",
		);
		const follow = await roomOpAction.handler(
			runtime,
			msg("follow the server"),
			state,
			opts({ action: "follow", scope: "server" }),
		);
		expect(follow.success).toBe(false);
		expect((follow.values as Record<string, unknown>).error).toBe(
			"ROOM_SCOPE_INVALID",
		);
	});

	it("validate gates on world mute state for scope=server", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
		});
		expect(
			await roomOpAction.validate(
				runtime,
				msg("mute the server"),
				state,
				opts({ action: "mute", scope: "server" }),
			),
		).toBe(false);
		expect(
			await roomOpAction.validate(
				runtime,
				msg("unmute the server"),
				state,
				opts({ action: "unmute", scope: "server" }),
			),
		).toBe(true);
	});
});
