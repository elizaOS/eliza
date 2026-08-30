/**
 * Exercises the structural manage-server authorization boundary with a
 * deterministic mock runtime, the real identity turn memo, and no database or
 * model. It owns revocation freshness and exact durable destination binding.
 */

import { describe, expect, it } from "vitest";
import { getVerifiedRelatedEntityIds } from "../identity-clusters.ts";
import { runWithTrajectoryContext } from "../trajectory-context.ts";
import type {
	IAgentRuntime,
	MessageConnectorManageServerDestination,
	Room,
	UUID,
	World,
} from "../types/index.ts";
import { authorizeManageServerDestination } from "./manage-server-authorization.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const LINKED_ADMIN_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const MESSAGE_SERVER_ID = "00000000-0000-0000-0000-000000000005" as UUID;
const OTHER_MESSAGE_SERVER_ID = "00000000-0000-0000-0000-000000000006" as UUID;
const BINDING_ROOM_A = "00000000-0000-0000-0000-000000000007" as UUID;
const BINDING_ROOM_B = "00000000-0000-0000-0000-000000000008" as UUID;
const AGENT_ONLY_ROOM = "00000000-0000-0000-0000-000000000009" as UUID;
const WRONG_SERVER_ROOM = "00000000-0000-0000-0000-000000000010" as UUID;

const destination: MessageConnectorManageServerDestination = {
	source: "discord",
	accountId: "primary",
	serverId: "guild-a",
	messageServerId: MESSAGE_SERVER_ID,
	destinationWorldId: WORLD_ID,
	target: {
		source: "discord",
		accountId: "primary",
		serverId: "guild-a",
	},
};

function room(id: UUID, overrides: Partial<Room> = {}): Room {
	return {
		id,
		agentId: AGENT_ID,
		worldId: WORLD_ID,
		source: destination.source,
		type: "GROUP",
		serverId: destination.serverId,
		messageServerId: MESSAGE_SERVER_ID,
		...overrides,
	};
}

function harness(options?: {
	world?: Partial<World>;
	rooms?: Room[];
	linked?: boolean;
	requesterRooms?: UUID[];
	agentRooms?: UUID[];
}) {
	let linked = options?.linked ?? true;
	let resolverCalls = 0;
	const world: World = {
		id: WORLD_ID,
		agentId: AGENT_ID,
		messageServerId: MESSAGE_SERVER_ID,
		metadata: {
			roles: { [LINKED_ADMIN_ID]: "ADMIN" },
			roleSources: { [LINKED_ADMIN_ID]: "manual" },
		},
		...options?.world,
	};
	const rooms = options?.rooms ?? [room(BINDING_ROOM_A)];
	const runtime = {
		agentId: AGENT_ID,
		getWorld: async (worldId: UUID) => (worldId === WORLD_ID ? world : null),
		getRooms: async (worldId: UUID) => (worldId === WORLD_ID ? rooms : []),
		getRoomsForParticipant: async (entityId: UUID) => {
			if (entityId === AGENT_ID) {
				return options?.agentRooms ?? [BINDING_ROOM_A];
			}
			if (entityId === LINKED_ADMIN_ID) {
				return options?.requesterRooms ?? [BINDING_ROOM_A];
			}
			return [];
		},
		getService: (name: string) =>
			name === "relationships"
				? {
						getVerifiedMemberEntityIds: async () => {
							resolverCalls += 1;
							return linked ? [LINKED_ADMIN_ID] : [];
						},
					}
				: null,
		getSetting: () => undefined,
	} as unknown as IAgentRuntime;

	return {
		runtime,
		revokeLink: () => {
			linked = false;
		},
		resolverCalls: () => resolverCalls,
	};
}

describe("authorizeManageServerDestination", () => {
	it("re-resolves a primed identity memo and denies a revoked linked admin", async () => {
		const { runtime, revokeLink, resolverCalls } = harness();

		await runWithTrajectoryContext({ turnMemo: new Map() }, async () => {
			expect(await getVerifiedRelatedEntityIds(runtime, REQUESTER_ID)).toEqual([
				REQUESTER_ID,
				LINKED_ADMIN_ID,
			]);
			revokeLink();

			await expect(
				authorizeManageServerDestination(runtime, REQUESTER_ID, destination),
			).rejects.toMatchObject({
				code: "MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED",
			});
		});

		expect(resolverCalls()).toBe(2);
	});

	it.each([
		["agent", { agentId: REQUESTER_ID }],
		["message server", { messageServerId: OTHER_MESSAGE_SERVER_ID }],
	])("denies a world bound to a different %s", async (_label, world) => {
		const { runtime } = harness({ world });

		await expect(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination),
		).rejects.toMatchObject({
			code: "MANAGE_SERVER_DESTINATION_UNBOUND",
		});
	});

	it("does not accept a same-world room bound to a different server", async () => {
		const { runtime } = harness({
			rooms: [room(WRONG_SERVER_ROOM, { serverId: "guild-b" })],
		});

		await expect(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination),
		).rejects.toMatchObject({
			code: "MANAGE_SERVER_DESTINATION_UNBOUND",
		});
	});

	it("returns the ADMIN identity and only its agent-shared binding rooms", async () => {
		const { runtime } = harness({
			rooms: [
				room(BINDING_ROOM_A),
				room(BINDING_ROOM_B),
				room(AGENT_ONLY_ROOM),
				room(WRONG_SERVER_ROOM, { serverId: "guild-b" }),
			],
			requesterRooms: [
				BINDING_ROOM_B,
				WRONG_SERVER_ROOM,
				BINDING_ROOM_A,
				BINDING_ROOM_B,
			],
			agentRooms: [
				BINDING_ROOM_A,
				BINDING_ROOM_B,
				AGENT_ONLY_ROOM,
				WRONG_SERVER_ROOM,
			],
		});

		await expect(
			authorizeManageServerDestination(runtime, REQUESTER_ID, destination),
		).resolves.toMatchObject({
			authorizedEntityId: LINKED_ADMIN_ID,
			role: "ADMIN",
			bindingRoomIds: [BINDING_ROOM_B, BINDING_ROOM_A],
		});
	});
});
