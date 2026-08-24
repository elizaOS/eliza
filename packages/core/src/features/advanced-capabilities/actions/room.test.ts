/**
 * ROOM action behaviour complementing room.mute.test.ts (which owns timed-mute
 * persistence and scope=server success paths): op resolution through parameter
 * aliases and message-text keyword inference, durationMinutes parsing rules,
 * server-scope failure branches, connector-targeted ops resolved by platform
 * + roomId/chatName, the model-decision gate on the current-room path, and the
 * forced-op validate/handler contract of the four child actions. Deterministic
 * map-backed runtime; only the model boundary answers from a scripted reply
 * queue, and assertions read the stores the inbound mute gate consults.
 */
import { describe, expect, it } from "vitest";
import type { Room, World } from "../../../types/environment";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index";
import {
	followRoomAction,
	muteRoomAction,
	roomOpAction,
	unfollowRoomAction,
	unmuteRoomAction,
} from "./room";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a2" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d3" as UUID;
const TARGET_ROOM_ID = "00000000-0000-0000-0000-0000000000d4" as UUID;
const SERVER_ROOM_ID = "00000000-0000-0000-0000-0000000000d5" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-0000000000d6" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e2" as UUID;
const OTHER_WORLD_ID = "00000000-0000-0000-0000-0000000000e3" as UUID;

type ParticipantState = "FOLLOWED" | "MUTED" | null;

function makeRuntime(seed?: {
	states?: Record<string, ParticipantState>;
	rooms?: Room[];
	worlds?: World[];
	participantRooms?: UUID[];
	replies?: string[];
}) {
	const states = new Map<string, ParticipantState>(
		Object.entries(seed?.states ?? {}),
	);
	const rooms = new Map<string, Room>(
		(seed?.rooms ?? []).map((entry) => [entry.id, entry]),
	);
	const worlds = new Map<string, World>(
		(seed?.worlds ?? []).map((entry) => [entry.id, entry]),
	);
	const participantRooms = seed?.participantRooms ?? [...rooms.keys()];
	const pendingReplies = [...(seed?.replies ?? [])];
	const modelCalls: string[] = [];
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
		useModel: async () => {
			modelCalls.push("call");
			return pendingReplies.shift() ?? "yes";
		},
		createMemory: async (memory: Memory) => {
			memories.push(memory);
			return memory.id;
		},
		getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
			states.get(`${roomId}:${entityId}`) ?? null,
		updateParticipantUserState: async (
			roomId: UUID,
			entityId: UUID,
			next: ParticipantState,
		) => {
			states.set(`${roomId}:${entityId}`, next);
		},
		getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
		updateRoom: async (room: Room) => {
			rooms.set(room.id, room);
		},
		getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
		updateWorld: async (world: World) => {
			worlds.set(world.id, world);
		},
		getRoomsForParticipant: async () => participantRooms,
	} as unknown as IAgentRuntime;
	return { runtime, states, rooms, worlds, modelCalls, memories };
}

function room(
	id: UUID,
	extra?: { source?: string; name?: string; worldId?: UUID },
): Room {
	return {
		id,
		name: extra?.name ?? `room-${id.slice(-2)}`,
		source: extra?.source ?? "discord",
		type: "GROUP",
		worldId: extra?.worldId ?? WORLD_ID,
	} as Room;
}

function world(id: UUID, name: string): World {
	return { id, agentId: AGENT_ID, name } as World;
}

function msg(text: string, roomId: UUID = ROOM_ID): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b2" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId,
		content: { text, source: "discord" },
	} as Memory;
}

function opts(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

const state = { values: {}, data: {}, text: "" } as State;

describe("ROOM action — op resolution", () => {
	it("rejects a request where no operation can be resolved", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("tell me a joke please"),
			state,
			opts({}),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Specify op: mute, unmute, follow, or unfollow.");
		expect((result.data as Record<string, unknown>).error).toBe(
			"ROOM_OP_REQUIRED",
		);
		expect(states.size).toBe(0);
	});

	it("resolves the restore_chat alias to unmute", async () => {
		const { runtime, states } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("bring the channel back"),
			state,
			opts({ op: "restore_chat" }),
		);
		expect(result.success).toBe(true);
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeNull();
		expect((result.values as Record<string, unknown>).roomUnmuted).toBe(true);
	});

	it("normalizes surrounding whitespace and casing in the action parameter", async () => {
		const { runtime, states, rooms } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("quiet this down"),
			state,
			opts({ action: "  MUTE " }),
		);
		expect(result.success).toBe(true);
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
		expect(rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso).toBeUndefined();
	});

	it("infers follow from message keywords when no parameters are supplied", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("hey please follow this room"),
			state,
			opts({}),
		);
		expect(result.success).toBe(true);
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("FOLLOWED");
		expect((result.values as Record<string, unknown>).roomFollowed).toBe(true);
	});
});

describe("ROOM action — durationMinutes parsing", () => {
	it("accepts a whole-number minute count supplied as a string", async () => {
		const { runtime, rooms } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const before = Date.now();
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this for half an hour"),
			state,
			opts({ action: "mute", durationMinutes: "30" }),
		);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		expect(data.durationMinutes).toBe(30);
		const iso = rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso;
		expect(typeof iso).toBe("string");
		const expiry = Date.parse(iso as string);
		expect(expiry).toBeGreaterThanOrEqual(before + 29 * 60_000);
		expect(expiry).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
	});

	it("rejects zero and negative durations instead of encoding an untimed mute", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		for (const duration of [0, -10]) {
			const result = await roomOpAction.handler(
				runtime,
				msg("mute this"),
				state,
				opts({ action: "mute", durationMinutes: duration }),
			);
			expect(result.success).toBe(false);
			const data = result.data as Record<string, unknown>;
			expect(data.error).toBe("ROOM_DURATION_INVALID");
			expect(data.durationMinutes).toBe(duration);
		}
		expect(states.size).toBe(0);
	});
});

describe("ROOM action — scope=server failure branches", () => {
	it("reports ROOM_SERVER_NOT_FOUND when the room has no world", async () => {
		const orphan = {
			id: SERVER_ROOM_ID,
			name: "loose-channel",
			source: "discord",
			type: "GROUP",
		} as Room;
		const { runtime } = makeRuntime({
			rooms: [orphan],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute the whole server", SERVER_ROOM_ID),
			state,
			opts({ action: "mute", scope: "server" }),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"That room does not belong to a server I can mute.",
		);
		expect((result.data as Record<string, unknown>).error).toBe(
			"ROOM_SERVER_NOT_FOUND",
		);
	});

	it("reports ROOM_SERVER_NOT_FOUND when the world record is gone", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute the whole server"),
			state,
			opts({ action: "mute", scope: "server" }),
		);
		expect(result.success).toBe(false);
		expect((result.values as Record<string, unknown>).error).toBe(
			"ROOM_SERVER_NOT_FOUND",
		);
	});

	it("refuses to unmute a server that is not muted", async () => {
		const { runtime, worlds } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("unmute the whole server"),
			state,
			opts({ action: "unmute", scope: "server" }),
		);
		expect(result.success).toBe(false);
		expect((result.values as Record<string, unknown>).error).toBe(
			"ROOM_UNMUTE_PRECONDITION_FAILED",
		);
		expect(result.text).toBe("Cannot unmute server from state NONE");
		expect(worlds.get(WORLD_ID)?.metadata?.agentMuteState).toBeUndefined();
	});

	it("treats scope=GUILD as server scope regardless of casing", async () => {
		const { runtime, worlds } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute the guild"),
			state,
			opts({ action: "mute", scope: "GUILD" }),
		);
		expect(result.success).toBe(true);
		expect(worlds.get(WORLD_ID)?.metadata?.agentMuteState).toBe("MUTED");
		const values = result.values as Record<string, unknown>;
		expect(values.scope).toBe("server");
		expect(values.serverName).toBe("Cozy Devs");
		expect(result.text).toBe("Server muted: Cozy Devs");
	});

	it("resolves the server-scoped target by platform + chatName", async () => {
		const { runtime, worlds } = makeRuntime({
			rooms: [
				room(SERVER_ROOM_ID, {
					name: "Announcements",
					source: "telegram",
					worldId: WORLD_ID,
				}),
				room(OTHER_ROOM_ID, { name: "General", worldId: OTHER_WORLD_ID }),
			],
			worlds: [
				world(WORLD_ID, "News Guild"),
				world(OTHER_WORLD_ID, "Quiet Guild"),
			],
			participantRooms: [SERVER_ROOM_ID, OTHER_ROOM_ID],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute that server"),
			state,
			opts({
				action: "mute",
				scope: "server",
				platform: "Telegram",
				chatName: "announcements",
			}),
		);
		expect(result.success).toBe(true);
		const values = result.values as Record<string, unknown>;
		expect(values.worldId).toBe(WORLD_ID);
		expect(values.serverName).toBe("News Guild");
		expect(worlds.get(WORLD_ID)?.metadata?.agentMuteState).toBe("MUTED");
		expect(
			worlds.get(OTHER_WORLD_ID)?.metadata?.agentMuteState,
		).toBeUndefined();
	});
});

describe("ROOM action — connector-targeted ops", () => {
	it("follows a room matched by case-insensitive partial chatName", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [
				room(TARGET_ROOM_ID, { name: "Crypto Signals Lounge" }),
				room(ROOM_ID, { name: "General" }),
			],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("follow the crypto signals channel"),
			state,
			opts({
				action: "follow",
				platform: "Discord",
				chatName: "crypto signals",
			}),
		);
		expect(result.success).toBe(true);
		expect(states.get(`${TARGET_ROOM_ID}:${AGENT_ID}`)).toBe("FOLLOWED");
		const values = result.values as Record<string, unknown>;
		expect(values.roomFollowed).toBe(true);
		expect(values.newState).toBe("FOLLOWED");
		expect(values.roomName).toBe("Crypto Signals Lounge");
	});

	it("reports ROOM_NOT_FOUND naming the platform when no chat matches", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute that ghost channel"),
			state,
			opts({
				action: "mute",
				platform: "telegram",
				chatName: "ghost-lounge",
			}),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("I couldn't find that telegram chat yet.");
		const data = result.data as Record<string, unknown>;
		expect(data.error).toBe("ROOM_NOT_FOUND");
		expect(data.platform).toBe("telegram");
		expect(states.size).toBe(0);
	});

	it("refuses to unfollow from NONE state on the targeted room", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(TARGET_ROOM_ID, { name: "Bounties" })],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("leave that channel"),
			state,
			opts({
				action: "unfollow",
				platform: "discord",
				roomId: TARGET_ROOM_ID,
			}),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Cannot unfollow room from state NONE");
		const values = result.values as Record<string, unknown>;
		expect(values.error).toBe("ROOM_UNFOLLOW_PRECONDITION_FAILED");
		const data = result.data as Record<string, unknown>;
		expect(data.currentState).toBe("NONE");
		expect(data.roomId).toBe(TARGET_ROOM_ID);
	});

	it("announces platform and minutes for a timed connector mute", async () => {
		const { runtime, states, rooms } = makeRuntime({
			rooms: [room(TARGET_ROOM_ID, { name: "Alpha Calls" })],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const before = Date.now();
		const result = await roomOpAction.handler(
			runtime,
			msg("mute alpha calls for three quarters of an hour"),
			state,
			opts({
				action: "mute",
				platform: "DISCORD",
				roomId: TARGET_ROOM_ID,
				durationMinutes: 45,
			}),
		);
		expect(result.success).toBe(true);
		expect(result.text).toBe("Muted Alpha Calls on discord for 45 minutes.");
		const data = result.data as Record<string, unknown>;
		expect(data.platform).toBe("discord");
		const iso = rooms.get(TARGET_ROOM_ID)?.metadata?.agentMuteUntilIso;
		expect(typeof iso).toBe("string");
		const expiry = Date.parse(iso as string);
		expect(expiry).toBeGreaterThanOrEqual(before + 44 * 60_000);
		expect(expiry).toBeLessThanOrEqual(Date.now() + 46 * 60_000);
		expect(data.scheduleAutoUnmuteIso).toBe(iso);
		expect(states.get(`${TARGET_ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
	});
});

describe("ROOM action — current-room model gate", () => {
	it("declines without mutating state when the model answers no", async () => {
		const { runtime, states, modelCalls } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
			replies: ["no"],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this channel"),
			state,
			opts({ action: "mute" }),
		);
		expect(result.success).toBe(true);
		expect(result.text).toBe("Decided not to mute room: room-d3");
		const values = result.values as Record<string, unknown>;
		expect(values.roomMuted).toBe(false);
		expect(values.reason).toBe("NOT_APPROPRIATE");
		expect(values.roomName).toBe("room-d3");
		const data = result.data as Record<string, unknown>;
		expect(data.muted).toBe(false);
		expect(data.reason).toBe("Decision criteria not met");
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeUndefined();
		expect(modelCalls.length).toBe(1);
	});

	it("treats an unclear model answer as a decline", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
			replies: ["perhaps later"],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this channel"),
			state,
			opts({ action: "mute" }),
		);
		expect(result.success).toBe(true);
		const values = result.values as Record<string, unknown>;
		expect(values.roomMuted).toBe(false);
		expect(values.reason).toBe("NOT_APPROPRIATE");
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeUndefined();
	});

	it("requires state on the current-room path", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this channel"),
			undefined,
			opts({ action: "mute" }),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("State is required for ROOM");
		expect((result.data as Record<string, unknown>).error).toBe(
			"STATE_REQUIRED",
		);
		expect(result.error).toBeInstanceOf(Error);
	});

	it("cannot mute a room the agent already muted and skips the model", async () => {
		const { runtime, modelCalls } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
			replies: ["yes"],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this channel again"),
			state,
			opts({ action: "mute" }),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Cannot mute room from state MUTED");
		const values = result.values as Record<string, unknown>;
		expect(values.error).toBe("ROOM_MUTE_PRECONDITION_FAILED");
		expect((result.data as Record<string, unknown>).currentState).toBe("MUTED");
		expect(modelCalls.length).toBe(0);
	});

	it("reports ROOM_NOT_FOUND after approval when the room record is missing", async () => {
		const { runtime, memories } = makeRuntime({
			replies: ["yes"],
		});
		const result = await roomOpAction.handler(
			runtime,
			msg("mute this channel"),
			state,
			opts({ action: "mute" }),
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Could not find room to mute");
		expect((result.data as Record<string, unknown>).error).toBe(
			"ROOM_NOT_FOUND",
		);
		expect(memories.length).toBe(1);
	});
});

describe("child actions force their operation", () => {
	it("validates mute/unmute against the forced op precondition", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID), room(TARGET_ROOM_ID), room(SERVER_ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
			states: {
				[`${ROOM_ID}:${AGENT_ID}`]: "MUTED",
				[`${TARGET_ROOM_ID}:${AGENT_ID}`]: "FOLLOWED",
			},
		});
		expect(
			await muteRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: ROOM_ID },
			} as HandlerOptions),
		).toBe(false);
		expect(
			await muteRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: TARGET_ROOM_ID },
			} as HandlerOptions),
		).toBe(true);
		expect(
			await unmuteRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: ROOM_ID },
			} as HandlerOptions),
		).toBe(true);
		expect(
			await unmuteRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: SERVER_ROOM_ID },
			} as HandlerOptions),
		).toBe(false);
	});

	it("validates follow/unfollow against the forced op precondition", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID), room(TARGET_ROOM_ID), room(SERVER_ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
			states: {
				[`${ROOM_ID}:${AGENT_ID}`]: "MUTED",
				[`${TARGET_ROOM_ID}:${AGENT_ID}`]: "FOLLOWED",
			},
		});
		expect(
			await followRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: TARGET_ROOM_ID },
			} as HandlerOptions),
		).toBe(false);
		expect(
			await followRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: ROOM_ID },
			} as HandlerOptions),
		).toBe(false);
		expect(
			await followRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: SERVER_ROOM_ID },
			} as HandlerOptions),
		).toBe(true);
		expect(
			await unfollowRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: TARGET_ROOM_ID },
			} as HandlerOptions),
		).toBe(true);
		expect(
			await unfollowRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: SERVER_ROOM_ID },
			} as HandlerOptions),
		).toBe(false);
		expect(
			await unfollowRoomAction.validate(runtime, msg(""), state, {
				parameters: { roomId: ROOM_ID },
			} as HandlerOptions),
		).toBe(false);
	});

	it("runs the forced op end to end without explicit parameters", async () => {
		const { runtime, states } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		const result = await muteRoomAction.handler(runtime, msg("hush"), state);
		expect(result.success).toBe(true);
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
		expect((result.values as Record<string, unknown>).roomMuted).toBe(true);
	});

	it("validate refuses to run without participant-state access", async () => {
		const bare = {
			agentId: AGENT_ID,
			character: { name: "Eliza" },
			useModel: async () => "yes",
		} as unknown as IAgentRuntime;
		expect(
			await roomOpAction.validate(
				bare,
				msg(""),
				state,
				opts({ action: "mute" }),
			),
		).toBe(false);
	});

	it("validate is vacuously available when no op is requested", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		expect(
			await roomOpAction.validate(runtime, msg("hello there"), state),
		).toBe(true);
	});

	it("validate fails when the connector target cannot be resolved", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
			participantRooms: [],
		});
		expect(
			await roomOpAction.validate(
				runtime,
				msg(""),
				state,
				opts({ action: "mute", platform: "slack", chatName: "ghost" }),
			),
		).toBe(false);
	});

	it("validate rejects follow under server scope", async () => {
		const { runtime } = makeRuntime({
			rooms: [room(ROOM_ID)],
			worlds: [world(WORLD_ID, "Cozy Devs")],
		});
		expect(
			await roomOpAction.validate(
				runtime,
				msg(""),
				state,
				opts({ action: "follow", scope: "server" }),
			),
		).toBe(false);
	});
});
