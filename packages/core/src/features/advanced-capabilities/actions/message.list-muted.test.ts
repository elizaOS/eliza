/**
 * Muted visibility in the MESSAGE list ops: list_channels carries a per-channel
 * `muted` flag and list_connections a `mutedRoomCount`, resolved from the same
 * participant/world state the ROOM action writes — making "which channels are
 * you muted in" answerable. Map-backed runtime + mock connectors.
 */
import { describe, expect, it } from "vitest";
import type { Room, World } from "../../../types/environment";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { messageAction } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const MUTED_ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const OPEN_ROOM_ID = "00000000-0000-0000-0000-0000000000d2" as UUID;
const MUTED_WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;

function mockConnector(
	source: string,
	label: string,
	rooms: Array<{ name: string; roomId?: UUID; serverId?: string }>,
) {
	return {
		source,
		label,
		capabilities: [],
		supportedTargetKinds: [],
		contexts: [],
		listRooms: async () =>
			rooms.map((room) => ({
				target: {
					source,
					...(room.roomId ? { roomId: room.roomId } : {}),
					...(room.serverId ? { serverId: room.serverId } : {}),
				},
				label: room.name,
				kind: "room" as const,
				score: 0.5,
				contexts: [],
			})),
	};
}

function mockRuntime(
	connectors: unknown[],
	seed?: {
		states?: Record<string, "FOLLOWED" | "MUTED">;
		rooms?: Room[];
		worlds?: World[];
	},
): IAgentRuntime {
	const states = new Map<string, "FOLLOWED" | "MUTED" | null>(
		Object.entries(seed?.states ?? {}),
	);
	const rooms = new Map<string, Room>(
		(seed?.rooms ?? []).map((room) => [room.id, room]),
	);
	const worlds = new Map<string, World>(
		(seed?.worlds ?? []).map((world) => [world.id, world]),
	);
	return {
		agentId: AGENT_ID,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		getMessageConnectors: () => connectors,
		getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
			states.get(`${roomId}:${entityId}`) ?? null,
		getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
		getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
	} as unknown as IAgentRuntime;
}

const message = {
	id: "00000000-0000-0000-0000-0000000000aa",
	roomId: "00000000-0000-0000-0000-0000000000bb",
	entityId: "00000000-0000-0000-0000-0000000000cc",
	agentId: AGENT_ID,
	content: { text: "which channels are you muted in?", source: "discord" },
	createdAt: 1,
} as unknown as Memory;

async function runOp(
	runtime: IAgentRuntime,
	parameters: Record<string, unknown>,
): Promise<ActionResult> {
	const result = await messageAction.handler(
		runtime,
		message,
		undefined,
		{ parameters },
		undefined,
		undefined,
	);
	if (!result) throw new Error("handler returned no result");
	return result;
}

describe("MESSAGE op=list_channels — muted flag", () => {
	it("flags room-muted channels and counts them in the summary", async () => {
		const runtime = mockRuntime(
			[
				mockConnector("discord", "Discord", [
					{ name: "#relay-flood", roomId: MUTED_ROOM_ID },
					{ name: "#general", roomId: OPEN_ROOM_ID },
				]),
			],
			{
				states: { [`${MUTED_ROOM_ID}:${AGENT_ID}`]: "MUTED" },
				rooms: [
					{ id: MUTED_ROOM_ID, source: "discord" } as Room,
					{ id: OPEN_ROOM_ID, source: "discord" } as Room,
				],
			},
		);
		const result = await runOp(runtime, { action: "list_channels" });
		const data = result.data as {
			channels: { label: string; muted: boolean }[];
		};
		expect(result.success).toBe(true);
		expect(data.channels.find((c) => c.label === "#relay-flood")?.muted).toBe(
			true,
		);
		expect(data.channels.find((c) => c.label === "#general")?.muted).toBe(
			false,
		);
		expect(result.text).toContain("(1 muted)");
	});

	it("flags every channel of a server-muted guild", async () => {
		const runtime = mockRuntime(
			[
				mockConnector("discord", "Discord", [
					{ name: "#a", roomId: OPEN_ROOM_ID, serverId: "guild-1" },
					{ name: "#b", roomId: MUTED_ROOM_ID, serverId: "guild-1" },
				]),
			],
			{
				worlds: [
					{
						id: MUTED_WORLD_ID,
						agentId: AGENT_ID,
						metadata: { agentMuteState: "MUTED" },
					} as World,
				],
			},
		);
		// The guild-id → worldId mapping is createUniqueUuid-based; answer for
		// any id so the mapping stays the resolver's concern.
		(runtime as unknown as { getWorld: unknown }).getWorld = async () =>
			({
				id: MUTED_WORLD_ID,
				agentId: AGENT_ID,
				metadata: { agentMuteState: "MUTED" },
			}) as World;
		const result = await runOp(runtime, { action: "list_channels" });
		const data = result.data as { channels: { muted: boolean }[] };
		expect(data.channels.every((c) => c.muted)).toBe(true);
	});
});

describe("MESSAGE op=list_connections — mutedRoomCount", () => {
	it("reports the muted room count per connection", async () => {
		const runtime = mockRuntime(
			[
				mockConnector("discord", "Discord", [
					{ name: "#relay-flood", roomId: MUTED_ROOM_ID },
					{ name: "#general", roomId: OPEN_ROOM_ID },
				]),
			],
			{
				states: { [`${MUTED_ROOM_ID}:${AGENT_ID}`]: "MUTED" },
				rooms: [{ id: MUTED_ROOM_ID, source: "discord" } as Room],
			},
		);
		const result = await runOp(runtime, { action: "list_connections" });
		const data = result.data as {
			connections: { platform: string; mutedRoomCount: number }[];
		};
		expect(
			data.connections.find((c) => c.platform === "discord")?.mutedRoomCount,
		).toBe(1);
	});
});
