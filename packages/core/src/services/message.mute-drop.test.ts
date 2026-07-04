/**
 * End-to-end mute drop through the real DefaultMessageService.handleMessage:
 * a MUTED room ends the turn with zero model calls EVEN when the message is a
 * direct @mention (mentionContext.isMention). On mention-gated deployments
 * every turn reaching the service is a mention, so any mention bypass makes
 * mute a no-op — this locks the mention-independence structurally. Fake
 * runtime over real state maps; useModel throws, so any inference attempt
 * fails the test.
 */
import { describe, expect, it, vi } from "vitest";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import type { Room, World } from "../types/environment";
import { EventType } from "../types/events";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;

function makeRuntime(seed: {
	states?: Record<string, "FOLLOWED" | "MUTED">;
	rooms?: Room[];
	worlds?: World[];
}) {
	const states = new Map<string, "FOLLOWED" | "MUTED" | null>(
		Object.entries(seed.states ?? {}),
	);
	const rooms = new Map<string, Room>(
		(seed.rooms ?? []).map((room) => [room.id, room]),
	);
	const worlds = new Map<string, World>(
		(seed.worlds ?? []).map((world) => [world.id, world]),
	);
	const emitEvent = vi.fn(async () => undefined);
	const useModel = vi.fn(async () => {
		throw new Error("useModel must NOT be called for a muted room");
	});
	const noop = () => {};
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza", username: "eliza" },
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		stateCache: new Map(),
		turnControllers: new TurnControllerRegistry(),
		emitEvent,
		useModel,
		getService: () => null,
		getSetting: () => undefined,
		startRun: () => RUN_ID,
		runActionsByMode: async () => undefined,
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		queueEmbeddingGeneration: async () => undefined,
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
	return { runtime, emitEvent, useModel, states };
}

function mentionMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b1" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: "hey @Eliza what do you think?",
			source: "discord",
			mentionContext: { isMention: true, mentionType: "platform_mention" },
		},
	} as unknown as Memory;
}

function room(extra?: Partial<Room>): Room {
	return {
		id: ROOM_ID,
		source: "discord",
		type: "GROUP",
		worldId: WORLD_ID,
		...extra,
	} as Room;
}

function runEndedStatuses(emitEvent: ReturnType<typeof vi.fn>): string[] {
	return emitEvent.mock.calls
		.filter(([event]) => event === EventType.RUN_ENDED)
		.map(([, payload]) => (payload as { status: string }).status);
}

describe("DefaultMessageService — muted room drops even a direct mention", () => {
	it("room-level mute: turn ends with status 'muted', zero model calls", async () => {
		const { runtime, emitEvent, useModel } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room()],
			worlds: [{ id: WORLD_ID, agentId: AGENT_ID, name: "Guild" }],
		});
		const service = new DefaultMessageService();
		const result = await service.handleMessage(runtime, mentionMessage());
		expect(result.didRespond).toBe(false);
		expect(result.mode).toBe("none");
		expect(useModel).not.toHaveBeenCalled();
		expect(runEndedStatuses(emitEvent)).toContain("muted");
	});

	it("server-level mute: a mention in an unmuted room of a muted guild drops too", async () => {
		const { runtime, emitEvent, useModel } = makeRuntime({
			rooms: [room()],
			worlds: [
				{
					id: WORLD_ID,
					agentId: AGENT_ID,
					name: "Guild",
					metadata: { agentMuteState: "MUTED" },
				},
			],
		});
		const service = new DefaultMessageService();
		const result = await service.handleMessage(runtime, mentionMessage());
		expect(result.didRespond).toBe(false);
		expect(useModel).not.toHaveBeenCalled();
		expect(runEndedStatuses(emitEvent)).toContain("muted");
	});

	it("expired timed mute: auto-unmutes at the ISO time and the turn proceeds past the gate", async () => {
		const past = new Date(Date.now() - 1_000).toISOString();
		const { runtime, emitEvent, states } = makeRuntime({
			states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
			rooms: [room({ metadata: { agentMuteUntilIso: past } })],
			worlds: [{ id: WORLD_ID, agentId: AGENT_ID, name: "Guild" }],
		});
		const service = new DefaultMessageService();
		// The deliberately-minimal fake cannot run the full Stage 1 pipeline;
		// passing the mute gate is proven by the auto-unmute write landing and
		// the turn NOT ending with status "muted" (it fails deeper instead).
		await service.handleMessage(runtime, mentionMessage()).catch(() => {});
		expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeNull();
		expect(runEndedStatuses(emitEvent)).not.toContain("muted");
	});

	it("unmuted room: the same mention proceeds past the mute gate", async () => {
		const { runtime, emitEvent } = makeRuntime({
			rooms: [room()],
			worlds: [{ id: WORLD_ID, agentId: AGENT_ID, name: "Guild" }],
		});
		const service = new DefaultMessageService();
		await service.handleMessage(runtime, mentionMessage()).catch(() => {});
		expect(runEndedStatuses(emitEvent)).not.toContain("muted");
	});
});
