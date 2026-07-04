/**
 * Effective-mute resolution: room participant mute, server-wide world mute,
 * the timed-mute due-check (the structural consumer of the ROOM action's
 * scheduleAutoUnmuteIso contract), and the muted flags for connector room
 * listings. Deterministic map-backed runtime; state transitions are asserted
 * against the stores, not mocks of the thing under test.
 */
import { describe, expect, it } from "vitest";
import type { Room, World } from "../../types/environment";
import type { UUID } from "../../types/primitives";
import type {
	IAgentRuntime,
	MessageConnectorTarget,
} from "../../types/runtime";
import {
	resolveEffectiveMuteState,
	resolveMutedTargetFlags,
	setRoomMuteUntil,
	setWorldMuteState,
	worldMuteActive,
} from "./mute-state";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const PARENT_ROOM_ID = "00000000-0000-0000-0000-0000000000d2" as UUID;
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
	const runtime = {
		agentId: AGENT_ID,
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
	return { runtime, states, rooms, worlds };
}

function room(id: UUID, extra?: Partial<Room>): Room {
	return {
		id,
		source: "discord",
		type: "GROUP",
		worldId: WORLD_ID,
		...extra,
	} as Room;
}

function world(extra?: Partial<World>): World {
	return { id: WORLD_ID, agentId: AGENT_ID, name: "Cozy Devs", ...extra };
}

describe("resolveEffectiveMuteState", () => {
	it("reports not muted when no room or world mute exists", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world()],
		});
		expect(
			await resolveEffectiveMuteState(runtime, { roomIds: [ROOM_ID] }),
		).toEqual({ muted: false });
	});

	it("reports a room-scoped mute for MUTED participant state (untimed)", async () => {
		const { runtime } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID)],
			worlds: [world()],
		});
		expect(
			await resolveEffectiveMuteState(runtime, { roomIds: [ROOM_ID] }),
		).toEqual({ muted: true, scope: "room", roomId: ROOM_ID });
	});

	it("keeps a timed mute active before its ISO expiry", async () => {
		const untilIso = new Date(Date.now() + 60_000).toISOString();
		const { runtime } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID, { metadata: { agentMuteUntilIso: untilIso } })],
			worlds: [world()],
		});
		expect(
			await resolveEffectiveMuteState(runtime, { roomIds: [ROOM_ID] }),
		).toEqual({ muted: true, scope: "room", roomId: ROOM_ID });
	});

	it("auto-unmutes a timed room mute at the ISO time and clears both stores", async () => {
		const untilIso = new Date(Date.now() - 1_000).toISOString();
		const { runtime, states, rooms } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID, { metadata: { agentMuteUntilIso: untilIso } })],
			worlds: [world()],
		});
		expect(
			await resolveEffectiveMuteState(runtime, { roomIds: [ROOM_ID] }),
		).toEqual({ muted: false });
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeNull();
		expect(rooms.get(ROOM_ID)?.metadata).not.toHaveProperty(
			"agentMuteUntilIso",
		);
	});

	it("a server-wide world mute drops a child room with no room-level mute", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
		});
		expect(
			await resolveEffectiveMuteState(runtime, { roomIds: [ROOM_ID] }),
		).toEqual({ muted: true, scope: "server", worldId: WORLD_ID });
	});

	it("consults an explicitly passed worldId without a room record", async () => {
		const { runtime } = makeRuntime({
			worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
		});
		expect(
			await resolveEffectiveMuteState(runtime, {
				roomIds: [ROOM_ID],
				worldId: WORLD_ID,
			}),
		).toEqual({ muted: true, scope: "server", worldId: WORLD_ID });
	});

	it("auto-unmutes a timed server mute at the ISO time and clears world metadata", async () => {
		const untilIso = new Date(Date.now() - 1_000).toISOString();
		const { runtime, worlds } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [
				world({
					metadata: {
						agentMuteState: "MUTED",
						agentMuteUntilIso: untilIso,
					},
				}),
			],
		});
		expect(
			await resolveEffectiveMuteState(runtime, { roomIds: [ROOM_ID] }),
		).toEqual({ muted: false });
		const metadata = worlds.get(WORLD_ID)?.metadata ?? {};
		expect(metadata).not.toHaveProperty("agentMuteState");
		expect(metadata).not.toHaveProperty("agentMuteUntilIso");
	});

	it("a muted ancestor room (thread parent) mutes the child", async () => {
		const { runtime } = makeRuntime({
			states: { [`${PARENT_ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID), room(PARENT_ROOM_ID)],
			worlds: [world()],
		});
		expect(
			await resolveEffectiveMuteState(runtime, {
				roomIds: [ROOM_ID, PARENT_ROOM_ID],
			}),
		).toEqual({ muted: true, scope: "room", roomId: PARENT_ROOM_ID });
	});
});

describe("setWorldMuteState / worldMuteActive", () => {
	it("mutes and unmutes a world in place", async () => {
		const { runtime, worlds } = makeRuntime({ worlds: [world()] });
		await setWorldMuteState(runtime, WORLD_ID, {});
		expect(worldMuteActive(worlds.get(WORLD_ID))).toBe(true);
		await setWorldMuteState(runtime, WORLD_ID, null);
		expect(worldMuteActive(worlds.get(WORLD_ID))).toBe(false);
		expect(worlds.get(WORLD_ID)?.metadata).not.toHaveProperty("agentMuteState");
	});

	it("returns null for an unknown world", async () => {
		const { runtime } = makeRuntime();
		expect(await setWorldMuteState(runtime, WORLD_ID, {})).toBeNull();
	});

	it("an expired timed world mute reads as inactive", () => {
		const past = new Date(Date.now() - 1_000).toISOString();
		expect(
			worldMuteActive(
				world({
					metadata: { agentMuteState: "MUTED", agentMuteUntilIso: past },
				}),
			),
		).toBe(false);
	});
});

describe("setRoomMuteUntil", () => {
	it("stores and clears the expiry on room metadata", async () => {
		const untilIso = new Date(Date.now() + 60_000).toISOString();
		const { runtime, rooms } = makeRuntime({ rooms: [room(ROOM_ID)] });
		await setRoomMuteUntil(runtime, ROOM_ID, untilIso);
		expect(rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso).toBe(untilIso);
		await setRoomMuteUntil(runtime, ROOM_ID, null);
		expect(rooms.get(ROOM_ID)?.metadata).not.toHaveProperty(
			"agentMuteUntilIso",
		);
	});

	it("throws when asked to store an expiry for a missing room", async () => {
		const { runtime } = makeRuntime();
		await expect(
			setRoomMuteUntil(runtime, ROOM_ID, new Date().toISOString()),
		).rejects.toThrow(/not found/);
	});
});

describe("resolveMutedTargetFlags", () => {
	it("flags room-muted and server-muted targets, read-only", async () => {
		// Target roomIds are explicit here; the createUniqueUuid fallback is
		// exercised by the plugin-discord inbound gate tests.
		const { runtime } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID), room(PARENT_ROOM_ID)],
			worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
		});
		// Server flag resolves via createUniqueUuid(runtime, serverId); patch
		// getWorld to answer for any id so the mapping itself stays opaque.
		(runtime as { getWorld: unknown }).getWorld = async () =>
			world({ metadata: { agentMuteState: "MUTED" } });
		const targets: MessageConnectorTarget[] = [
			{ target: { source: "discord", roomId: ROOM_ID } },
			{ target: { source: "discord", roomId: PARENT_ROOM_ID } },
			{
				target: {
					source: "discord",
					roomId: PARENT_ROOM_ID,
					serverId: "guild-1",
				},
			},
		];
		expect(await resolveMutedTargetFlags(runtime, targets)).toEqual([
			true,
			false,
			true,
		]);
	});

	it("reports an expired timed room mute as unmuted without writing", async () => {
		const past = new Date(Date.now() - 1_000).toISOString();
		const { runtime, states } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [
				room(ROOM_ID, {
					worldId: undefined,
					metadata: { agentMuteUntilIso: past },
				}),
			],
		});
		const targets: MessageConnectorTarget[] = [
			{ target: { source: "discord", roomId: ROOM_ID } },
		];
		expect(await resolveMutedTargetFlags(runtime, targets)).toEqual([false]);
		// Read-only: the inbound due-check owns the expiry write.
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
	});
});
