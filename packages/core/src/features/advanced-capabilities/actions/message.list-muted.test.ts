/**
 * Muted visibility and count integrity in the MESSAGE list ops: list_channels
 * carries a per-channel `muted` flag, list_servers a per-server `muted`
 * flag, and list_connections a `mutedRoomCount`, resolved from the same
 * participant/world state the ROOM action writes — making "which channels or
 * servers are you muted in" answerable. Counts must cover the connector's
 * COMPLETE room set even when the rendered listing is capped, and a capped
 * listing is annotated (truncated + channelCount) rather than posing as
 * complete. Map-backed runtime + mock connectors.
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

describe("MESSAGE list ops — counts stay complete past the render cap", () => {
	const roomId = (i: number): UUID =>
		`00000000-0000-0000-0000-${String(i).padStart(12, "0")}` as UUID;
	// 60 rooms; the muted ones sit past index 50 so a truncated fetch would
	// miss them entirely.
	const mutedIndexes = [55, 56, 57];
	const bigConnector = () =>
		mockConnector(
			"discord",
			"Discord",
			Array.from({ length: 60 }, (_, i) => ({
				name: `#chan-${i}`,
				roomId: roomId(i),
			})),
		);
	const seed = () => ({
		states: Object.fromEntries(
			mutedIndexes.map((i) => [`${roomId(i)}:${AGENT_ID}`, "MUTED" as const]),
		),
		rooms: mutedIndexes.map(
			(i) => ({ id: roomId(i), source: "discord" }) as Room,
		),
	});

	it("list_channels reports the full channel + muted counts and annotates the capped listing", async () => {
		const runtime = mockRuntime([bigConnector()], seed());
		const result = await runOp(runtime, { action: "list_channels" });
		const data = result.data as {
			channelCount: number;
			truncated?: boolean;
			channels: { label: string }[];
		};
		expect(result.success).toBe(true);
		expect(data.channelCount).toBe(60);
		expect(data.truncated).toBe(true);
		expect(data.channels).toHaveLength(50);
		expect(result.text).toContain("Listed 60 channels");
		expect(result.text).toContain("(3 muted)");
		expect(result.text).toContain("showing the first 50");
	});

	it("list_connections counts every room and every muted room, not just the first 50", async () => {
		const runtime = mockRuntime([bigConnector()], seed());
		const result = await runOp(runtime, { action: "list_connections" });
		const data = result.data as {
			connections: {
				platform: string;
				roomCount: number;
				mutedRoomCount: number;
			}[];
		};
		const discord = data.connections.find((c) => c.platform === "discord");
		expect(discord?.roomCount).toBe(60);
		expect(discord?.mutedRoomCount).toBe(3);
	});
});

describe("MESSAGE op=list_servers — muted flag", () => {
	const MUTED_SERVER_WORLD_ID = "00000000-0000-0000-0000-0000000000e2" as UUID;
	const OPEN_SERVER_WORLD_ID = "00000000-0000-0000-0000-0000000000e3" as UUID;

	function serverConnector(worlds: World[]) {
		return {
			source: "discord",
			label: "Discord",
			capabilities: [],
			supportedTargetKinds: [],
			contexts: [],
			listServers: async () => worlds,
		};
	}

	it("resolves the server-wide mute from the persisted world when the connector lists a bare World", async () => {
		// The connector fabricates Worlds without durable metadata (the discord
		// listing builds them from the live guild cache) — the persisted world
		// under the same id carries the mute.
		const runtime = mockRuntime(
			[
				serverConnector([
					{
						id: MUTED_SERVER_WORLD_ID,
						agentId: AGENT_ID,
						name: "Muted Guild",
						metadata: { source: "discord" },
					} as World,
					{
						id: OPEN_SERVER_WORLD_ID,
						agentId: AGENT_ID,
						name: "Open Guild",
						metadata: { source: "discord" },
					} as World,
				]),
			],
			{
				worlds: [
					{
						id: MUTED_SERVER_WORLD_ID,
						agentId: AGENT_ID,
						metadata: { agentMuteState: "MUTED" },
					} as World,
				],
			},
		);
		const result = await runOp(runtime, { action: "list_servers" });
		const data = result.data as {
			servers: { name?: string; muted: boolean }[];
		};
		expect(result.success).toBe(true);
		expect(data.servers.find((s) => s.name === "Muted Guild")?.muted).toBe(
			true,
		);
		expect(data.servers.find((s) => s.name === "Open Guild")?.muted).toBe(
			false,
		);
		expect(result.text).toContain("(1 muted)");
	});

	it("trusts mute metadata the connector already carries, honoring timed expiry", async () => {
		const runtime = mockRuntime([
			serverConnector([
				{
					id: MUTED_SERVER_WORLD_ID,
					agentId: AGENT_ID,
					name: "Muted Guild",
					metadata: { agentMuteState: "MUTED" },
				} as World,
				{
					id: OPEN_SERVER_WORLD_ID,
					agentId: AGENT_ID,
					name: "Expired Guild",
					metadata: {
						agentMuteState: "MUTED",
						agentMuteUntilIso: "2001-01-01T00:00:00.000Z",
					},
				} as World,
			]),
		]);
		const result = await runOp(runtime, { action: "list_servers" });
		const data = result.data as {
			servers: { name?: string; muted: boolean }[];
		};
		expect(data.servers.find((s) => s.name === "Muted Guild")?.muted).toBe(
			true,
		);
		expect(data.servers.find((s) => s.name === "Expired Guild")?.muted).toBe(
			false,
		);
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
