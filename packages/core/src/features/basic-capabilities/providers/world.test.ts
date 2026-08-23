/**
 * Unit tests for the WORLD provider's lookup failures and successful room
 * categorization. The harness uses typed runtime stubs while exercising the
 * real provider formatting and data assembly.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	IAgentRuntime,
	Memory,
	Room,
	State,
	UUID,
	World,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import worldProviderDefault, { worldProvider } from "./world.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;

const message = {
	agentId: AGENT_ID,
	roomId: ROOM_ID,
	entityId: "00000000-0000-0000-0000-000000000004" as UUID,
	content: { text: "Where are we?", source: "discord" },
} as Memory;

const state: State = { values: {}, data: {}, text: "" };

function room(
	id: UUID,
	name: string,
	type: Room["type"],
	overrides: Partial<Room> = {},
): Room {
	return {
		id,
		name,
		type,
		source: "discord",
		agentId: AGENT_ID,
		worldId: WORLD_ID,
		...overrides,
	};
}

function runtimeWith(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return createMockRuntime({
		agentId: AGENT_ID,
		getRoom: vi.fn(async () => room(ROOM_ID, "general", ChannelType.GROUP)),
		getWorld: vi.fn(async () => ({
			id: WORLD_ID,
			name: "Test World",
			agentId: AGENT_ID,
		})),
		getRooms: vi.fn(async () => []),
		getParticipantsForRoom: vi.fn(async () => []),
		...overrides,
	});
}

describe("worldProvider", () => {
	it("exports the same provider as the named and default export", () => {
		expect(worldProviderDefault).toBe(worldProvider);
		expect(worldProvider).toMatchObject({
			name: "WORLD",
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "GUEST" },
		});
	});

	it("returns an explanatory result when the current room is missing", async () => {
		const getWorld = vi.fn<IAgentRuntime["getWorld"]>();
		const runtime = runtimeWith({
			getRoom: vi.fn(async () => null),
			getWorld,
		});

		const result = await worldProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: {
				world: {
					info: "Unable to retrieve world information - room not found",
				},
			},
			values: {},
			text: "Unable to retrieve world information - room not found",
		});
		expect(getWorld).not.toHaveBeenCalled();
	});

	it("stops before the world lookup when the room has no world ID", async () => {
		const getWorld = vi.fn<IAgentRuntime["getWorld"]>();
		const runtime = runtimeWith({
			getRoom: vi.fn(async () =>
				room(ROOM_ID, "direct", ChannelType.DM, { worldId: undefined }),
			),
			getWorld,
		});

		const result = await worldProvider.get(runtime, message, state);

		expect(result.text).toBe(
			"Unable to retrieve world information - world ID not found",
		);
		expect(result.data).toEqual({
			world: {
				info: "Unable to retrieve world information - world ID not found",
			},
		});
		expect(getWorld).not.toHaveBeenCalled();
	});

	it("returns an explanatory result when the referenced world is missing", async () => {
		const getRooms = vi.fn<IAgentRuntime["getRooms"]>();
		const runtime = runtimeWith({
			getWorld: vi.fn(async () => null),
			getRooms,
		});

		const result = await worldProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: {
				world: {
					info: "Unable to retrieve world information - world not found",
				},
			},
			values: {},
			text: "Unable to retrieve world information - world not found",
		});
		expect(getRooms).not.toHaveBeenCalled();
	});

	it("categorizes every channel type, preserves order, and skips incomplete rooms", async () => {
		const rooms: Room[] = [
			room(ROOM_ID, "general", ChannelType.GROUP, { channelId: "C-general" }),
			room(
				"00000000-0000-0000-0000-000000000010" as UUID,
				"lobby",
				ChannelType.WORLD,
			),
			room(
				"00000000-0000-0000-0000-000000000011" as UUID,
				"forum",
				ChannelType.FORUM,
			),
			room(
				"00000000-0000-0000-0000-000000000012" as UUID,
				"voice",
				ChannelType.VOICE_GROUP,
			),
			room(
				"00000000-0000-0000-0000-000000000013" as UUID,
				"voice-dm",
				ChannelType.VOICE_DM,
			),
			room(
				"00000000-0000-0000-0000-000000000014" as UUID,
				"dm",
				ChannelType.DM,
			),
			room(
				"00000000-0000-0000-0000-000000000015" as UUID,
				"self",
				ChannelType.SELF,
			),
			room(
				"00000000-0000-0000-0000-000000000016" as UUID,
				"feed",
				ChannelType.FEED,
			),
			room(
				"00000000-0000-0000-0000-000000000017" as UUID,
				"thread",
				ChannelType.THREAD,
			),
			room(
				"00000000-0000-0000-0000-000000000018" as UUID,
				"api",
				ChannelType.API,
			),
			room("" as UUID, "missing-id", ChannelType.GROUP),
			room(
				"00000000-0000-0000-0000-000000000019" as UUID,
				"",
				ChannelType.GROUP,
			),
		];
		const world: World = {
			id: WORLD_ID,
			name: "Builders",
			agentId: AGENT_ID,
			messageServerId: "00000000-0000-0000-0000-000000000020" as UUID,
			metadata: { region: "earth" },
		};
		const getRooms = vi.fn(async () => rooms);
		const getParticipantsForRoom = vi.fn(async () => [
			"00000000-0000-0000-0000-000000000021" as UUID,
			"00000000-0000-0000-0000-000000000022" as UUID,
		]);
		const runtime = runtimeWith({
			getRoom: vi.fn(async () => rooms[0]),
			getWorld: vi.fn(async () => world),
			getRooms,
			getParticipantsForRoom,
		});

		const result = await worldProvider.get(runtime, message, state);
		const worldData = result.data?.world as {
			currentRoom: { participantCount: number; channelId?: string };
			channels: Record<string, Array<Record<string, unknown>>>;
			channelStats: Record<string, number>;
			metadata: Record<string, unknown>;
		};

		expect(getRooms).toHaveBeenCalledWith(WORLD_ID);
		expect(getParticipantsForRoom).toHaveBeenCalledWith(ROOM_ID);
		expect(worldData.currentRoom).toMatchObject({
			participantCount: 2,
			channelId: "C-general",
		});
		expect(worldData.metadata).toEqual({ region: "earth" });
		expect(worldData.channelStats).toEqual({
			total: 12,
			text: 3,
			voice: 2,
			dm: 2,
			feed: 1,
			thread: 1,
			other: 1,
		});
		expect(worldData.channels.text.map((channel) => channel.name)).toEqual([
			"general",
			"lobby",
			"forum",
		]);
		expect(worldData.channels.text[0]).toMatchObject({
			id: ROOM_ID,
			isCurrentChannel: true,
		});
		expect(worldData.channels.text[1]).toMatchObject({
			isCurrentChannel: false,
		});
		expect(worldData.channels.other).toEqual([
			{
				id: "00000000-0000-0000-0000-000000000018",
				name: "api",
				isCurrentChannel: false,
				type: ChannelType.API,
			},
		]);
		expect(result.values).toMatchObject({
			worldName: "Builders",
			currentChannelName: "general",
		});
		expect(result.text).toBe(
			[
				"# World Information",
				"# World: Builders",
				"Current Channel: general (GROUP)",
				"Total Channels: 12",
				"Participants in current channel: 2",
				"",
				"Text channels: 3",
				"Voice channels: 2",
				"DM channels: 2",
				"Feed channels: 1",
				"Thread channels: 1",
				"Other channels: 1",
				"",
			].join("\n"),
		);
	});

	it("returns zero counts and empty metadata for an otherwise empty world", async () => {
		const runtime = runtimeWith();

		const result = await worldProvider.get(runtime, message, state);

		expect(result.data?.world).toMatchObject({
			metadata: {},
			channels: {
				text: [],
				voice: [],
				dm: [],
				feed: [],
				thread: [],
				other: [],
			},
			channelStats: {
				total: 0,
				text: 0,
				voice: 0,
				dm: 0,
				feed: 0,
				thread: 0,
				other: 0,
			},
			currentRoom: { participantCount: 0 },
		});
		expect(result.values?.worldInfo).toContain("Total Channels: 0");
		expect(result.values?.worldInfo).toContain(
			"Participants in current channel: 0",
		);
	});
});
