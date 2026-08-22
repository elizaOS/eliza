/**
 * Authorized world and room discovery for MESSAGE uses a map-backed durable
 * topology with linked owner accounts. The tests prove cluster expansion,
 * shared-participant intersection, explicit pagination, world scoping, and
 * fail-closed behavior outside a freshly attested owner-private destination.
 */
import { describe, expect, it, vi } from "vitest";
import { attestDeliveryAudienceFromCanonicalRoom } from "../../../security/trusted-delivery-audience.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	Room,
	UUID,
	World,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { messageAction } from "./message.ts";

const AGENT = "00000000-0000-0000-0000-000000000001" as UUID;
const DISCORD_OWNER = "00000000-0000-0000-0000-000000000002" as UUID;
const TELEGRAM_OWNER = "00000000-0000-0000-0000-000000000003" as UUID;
const UNRELATED = "00000000-0000-0000-0000-000000000004" as UUID;
const CURRENT_ROOM = "00000000-0000-0000-0000-000000000011" as UUID;
const DISCORD_ROOM = "00000000-0000-0000-0000-000000000012" as UUID;
const TELEGRAM_ROOM = "00000000-0000-0000-0000-000000000013" as UUID;
const UNRELATED_ROOM = "00000000-0000-0000-0000-000000000014" as UUID;
const DISCORD_WORLD = "00000000-0000-0000-0000-000000000021" as UUID;
const TELEGRAM_WORLD = "00000000-0000-0000-0000-000000000022" as UUID;
const UNRELATED_WORLD = "00000000-0000-0000-0000-000000000023" as UUID;

const worlds: World[] = [
	{
		id: DISCORD_WORLD,
		name: "Discord Guild",
		agentId: AGENT,
		messageServerId: "00000000-0000-0000-0000-000000000031" as UUID,
	},
	{
		id: TELEGRAM_WORLD,
		name: "Telegram Community",
		agentId: AGENT,
		messageServerId: "00000000-0000-0000-0000-000000000032" as UUID,
	},
	{
		id: UNRELATED_WORLD,
		name: "Unrelated World",
		agentId: AGENT,
	},
];

const rooms: Room[] = [
	{
		id: CURRENT_ROOM,
		name: "owner-dm",
		agentId: AGENT,
		source: "discord",
		type: ChannelType.DM,
		worldId: DISCORD_WORLD,
	},
	{
		id: DISCORD_ROOM,
		name: "project-alpha",
		agentId: AGENT,
		source: "discord",
		type: ChannelType.DM,
		worldId: DISCORD_WORLD,
	},
	{
		id: TELEGRAM_ROOM,
		name: "travel-planning",
		agentId: AGENT,
		source: "telegram",
		type: ChannelType.DM,
		worldId: TELEGRAM_WORLD,
	},
	{
		id: UNRELATED_ROOM,
		name: "someone-else",
		agentId: AGENT,
		source: "discord",
		type: ChannelType.DM,
		worldId: UNRELATED_WORLD,
	},
];

type Harness = {
	runtime: IAgentRuntime;
	message: Memory;
	getRoomsByIds: ReturnType<typeof vi.fn>;
};

function harness(channelType: ChannelType = ChannelType.DM): Harness {
	const roomById = new Map(rooms.map((room) => [room.id, room]));
	const worldById = new Map(worlds.map((world) => [world.id, world]));
	const participantRooms = new Map<UUID, UUID[]>([
		[AGENT, [CURRENT_ROOM, DISCORD_ROOM, TELEGRAM_ROOM, UNRELATED_ROOM]],
		[DISCORD_OWNER, [CURRENT_ROOM]],
		[TELEGRAM_OWNER, [DISCORD_ROOM, TELEGRAM_ROOM]],
		[UNRELATED, [UNRELATED_ROOM]],
	]);
	const getRoomsByIds = vi.fn(async (ids: UUID[]) =>
		ids.flatMap((id) => {
			const room = roomById.get(id);
			return room ? [room] : [];
		}),
	);
	const runtime = {
		agentId: AGENT,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		reportError: vi.fn(),
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? DISCORD_OWNER : undefined,
		),
		getService: vi.fn((serviceType: string) =>
			serviceType === "relationships"
				? {
						serviceType: "relationships",
						capabilityDescription: "linked identity test service",
						stop: async () => undefined,
						getMemberEntityIds: async () => [DISCORD_OWNER, TELEGRAM_OWNER],
						getVerifiedMemberEntityIds: async () => [
							DISCORD_OWNER,
							TELEGRAM_OWNER,
						],
					}
				: null,
		),
		getRoom: vi.fn(async (roomId: UUID) => {
			const room = roomById.get(roomId);
			return room
				? {
						...room,
						type: roomId === CURRENT_ROOM ? channelType : room.type,
					}
				: null;
		}),
		getParticipantsForRoom: vi.fn(async (roomId: UUID) =>
			roomId === CURRENT_ROOM ? [DISCORD_OWNER, AGENT] : [],
		),
		getRoomsForParticipant: vi.fn(
			async (entityId: UUID) => participantRooms.get(entityId) ?? [],
		),
		getRoomsByIds,
		getWorldsByIds: vi.fn(async (ids: UUID[]) =>
			ids.flatMap((id) => {
				const world = worldById.get(id);
				return world ? [world] : [];
			}),
		),
	} as unknown as IAgentRuntime;
	const message = {
		id: "00000000-0000-0000-0000-000000000041" as UUID,
		entityId: DISCORD_OWNER,
		agentId: AGENT,
		roomId: CURRENT_ROOM,
		content: {
			text: "where else have we talked?",
			source: "discord",
			channelType,
		},
		createdAt: 1,
	} as Memory;
	return { runtime, message, getRoomsByIds };
}

async function run(
	h: Harness,
	parameters: Record<string, unknown>,
): Promise<ActionResult> {
	await attestDeliveryAudienceFromCanonicalRoom(h.runtime, h.message);
	const result = await messageAction.handler(
		h.runtime,
		h.message,
		undefined,
		{ parameters },
		undefined,
		undefined,
	);
	if (!result) throw new Error("MESSAGE handler returned no result");
	return result;
}

describe("MESSAGE authorized world and room discovery", () => {
	it("is eligible when Stage 1 routes topology discovery to the world context", async () => {
		const h = harness();
		await expect(
			messageAction.validate(h.runtime, h.message, {
				values: { __contextRouting: { primaryContext: "world" } },
				data: {},
				text: "",
			}),
		).resolves.toBe(true);
	});

	it("accepts an explicit topology read without model routing state", async () => {
		const h = harness();
		await expect(
			messageAction.validate(h.runtime, h.message, undefined, {
				parameters: { action: "list_worlds" },
			}),
		).resolves.toBe(true);
	});

	it("discovers worlds shared through any linked requester account", async () => {
		const h = harness();
		const result = await run(h, { action: "list_worlds" });
		const data = result.data as {
			worlds: Array<{ worldId: UUID; sharedRoomCount: number }>;
		};

		expect(result.success).toBe(true);
		expect(data.worlds).toEqual([
			expect.objectContaining({
				worldId: DISCORD_WORLD,
				sharedRoomCount: 2,
			}),
			expect.objectContaining({
				worldId: TELEGRAM_WORLD,
				sharedRoomCount: 1,
			}),
		]);
		expect(data.worlds).not.toContainEqual(
			expect.objectContaining({ worldId: UNRELATED_WORLD }),
		);
		expect(h.getRoomsByIds).toHaveBeenCalledTimes(1);
		expect(new Set(h.getRoomsByIds.mock.calls[0]?.[0])).toEqual(
			new Set([CURRENT_ROOM, DISCORD_ROOM, TELEGRAM_ROOM]),
		);
	});

	it("lists the current world's rooms or another authorized world explicitly", async () => {
		const current = await run(harness(), { action: "list_rooms" });
		const currentRooms = (
			current.data as { rooms: Array<{ roomId: UUID }> }
		).rooms.map((room) => room.roomId);
		expect(currentRooms).toEqual([CURRENT_ROOM, DISCORD_ROOM]);

		const other = await run(harness(), {
			action: "list_rooms",
			worldId: TELEGRAM_WORLD,
		});
		expect((other.data as { rooms: Array<{ roomId: UUID }> }).rooms).toEqual([
			expect.objectContaining({ roomId: TELEGRAM_ROOM }),
		]);
	});

	it("paginates only when the caller explicitly supplies a limit", async () => {
		const first = await run(harness(), {
			action: "list_worlds",
			limit: 1,
		});
		expect(first.data).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
		expect((first.data as { worlds: unknown[] }).worlds).toHaveLength(1);

		const second = await run(harness(), {
			action: "list_worlds",
			limit: 1,
			offset: 1,
		});
		expect(second.data).toMatchObject({
			total: 2,
			offset: 1,
			nextOffset: null,
		});
		expect((second.data as { worlds: unknown[] }).worlds).toHaveLength(1);
	});

	it("rejects malformed and unshared world ids", async () => {
		const malformed = await run(harness(), {
			action: "list_rooms",
			worldId: "not-a-uuid",
		});
		expect(malformed).toMatchObject({
			success: false,
			data: { error: "INVALID_WORLD_ID" },
		});

		const unshared = await run(harness(), {
			action: "list_rooms",
			worldId: UNRELATED_WORLD,
		});
		expect(unshared).toMatchObject({
			success: false,
			data: { error: "WORLD_NOT_AUTHORIZED" },
		});
	});

	it("fails closed in a group before reading cross-world topology", async () => {
		const h = harness(ChannelType.GROUP);
		const result = await run(h, { action: "list_worlds" });

		expect(result).toMatchObject({
			success: false,
			data: { error: "PRIVATE_DESTINATION_REQUIRED" },
		});
		expect(h.getRoomsByIds).not.toHaveBeenCalled();
	});
});
