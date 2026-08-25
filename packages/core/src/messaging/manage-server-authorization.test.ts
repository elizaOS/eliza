/**
 * Unit coverage for `authorizeManageServerDestination`: the structural
 * server-management authority guard. Verifies the deny paths (unbound world,
 * missing exact room binding, non-admin requester), the metadata ownership
 * paths, verified identity-cluster expansion, and that the turn memo for the
 * requester's identity cluster is invalidated before re-resolution — against
 * a scripted mock runtime, no DB.
 */
import { describe, expect, it, vi } from "vitest";
import { getVerifiedRelatedEntityIds } from "../identity-clusters.ts";
import { runWithTrajectoryContext } from "../trajectory-context.ts";
import type { IAgentRuntime, UUID } from "../types/index.ts";
import { authorizeManageServerDestination } from "./manage-server-authorization.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const REQUESTER = "11111111-1111-1111-1111-1111111111aa" as UUID;
const ALIAS = "22222222-2222-2222-2222-2222222222aa" as UUID;
const OTHER_USER = "33333333-3333-3333-3333-3333333333aa" as UUID;
const WORLD_ID = "44444444-4444-4444-4444-4444444444aa" as UUID;
const MESSAGE_SERVER_ID = "55555555-5555-5555-5555-5555555555aa" as UUID;
const ROOM_1 = "66666666-6666-6666-6666-6666666666aa" as UUID;
const ROOM_2 = "77777777-7777-7777-7777-7777777777aa" as UUID;
const OTHER_WORLD_ROOM = "88888888-8888-8888-8888-8888888888aa" as UUID;

interface MockRoom {
	id: UUID;
	worldId?: UUID;
	source: string;
	serverId?: string;
	messageServerId?: UUID;
}

interface MockWorld {
	id: UUID;
	agentId: UUID;
	messageServerId?: UUID;
	metadata?: Record<string, unknown>;
}

interface MockRuntimeOptions {
	world?: MockWorld | null;
	rooms?: MockRoom[];
	participantRooms?: Record<string, UUID[]>;
	services?: Record<string, unknown>;
	settings?: Record<string, string>;
}

function buildRuntime(opts: MockRuntimeOptions = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getWorld: vi.fn(async () => opts.world ?? null),
		getRooms: vi.fn(async () => opts.rooms ?? []),
		getRoomsForParticipant: vi.fn(async (entityId: UUID) => {
			return opts.participantRooms?.[entityId] ?? [];
		}),
		getService: vi.fn((type: string) => {
			return opts.services ? (opts.services[type] ?? null) : null;
		}),
		getSetting: vi.fn((key: string) => opts.settings?.[key] ?? null),
	} as unknown as IAgentRuntime;
}

function makeDestination(): Parameters<
	typeof authorizeManageServerDestination
>[2] {
	return {
		source: "discord",
		accountId: "acct-1",
		serverId: "server-1",
		messageServerId: MESSAGE_SERVER_ID,
		destinationWorldId: WORLD_ID,
		target: {
			source: "discord",
			accountId: "acct-1",
			serverId: "server-1",
		},
	};
}

function boundWorld(metadata?: Record<string, unknown>): MockWorld {
	return {
		id: WORLD_ID,
		agentId: AGENT_ID,
		messageServerId: MESSAGE_SERVER_ID,
		metadata,
	};
}

function boundRoom(id: UUID): MockRoom {
	return {
		id,
		worldId: WORLD_ID,
		source: "discord",
		serverId: "server-1",
		messageServerId: MESSAGE_SERVER_ID,
	};
}

/** World metadata granting `role` to `entityId` with a manual grant source. */
function roleMetadata(entityId: UUID, role: string): Record<string, unknown> {
	return {
		roles: { [entityId]: role },
		roleSources: { [entityId]: "manual" },
	};
}

async function expectDenyCode(
	runtime: IAgentRuntime,
	dest: Parameters<typeof authorizeManageServerDestination>[2],
	code: string,
): Promise<void> {
	let caught: unknown;
	try {
		await authorizeManageServerDestination(runtime, REQUESTER, dest);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	const elizaError = caught as { code?: string; context?: unknown };
	expect(elizaError.code).toBe(code);
}

describe("authorizeManageServerDestination", () => {
	it("denies when the destination world does not exist", async () => {
		const runtime = buildRuntime({ world: null });
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_UNBOUND",
		);
	});

	it("denies when the world belongs to a different agent", async () => {
		const runtime = buildRuntime({
			world: { ...boundWorld(), agentId: OTHER_USER },
		});
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_UNBOUND",
		);
	});

	it("denies when the world's messageServerId differs from the destination", async () => {
		const runtime = buildRuntime({
			world: { ...boundWorld(), messageServerId: OTHER_WORLD_ROOM },
		});
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_UNBOUND",
		);
	});

	it("denies when no persisted room exactly matches the server binding", async () => {
		const runtime = buildRuntime({
			world: boundWorld(),
			rooms: [{ ...boundRoom(ROOM_1), serverId: "other-server" }],
		});
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_UNBOUND",
		);
	});

	it.each([
		["worldId", { worldId: OTHER_WORLD_ROOM }],
		["source", { source: "telegram" }],
		["room messageServerId", { messageServerId: OTHER_WORLD_ROOM }],
	] as const)(
		"denies when a room diverges from the binding on %s",
		async (_field, roomDelta) => {
			const runtime = buildRuntime({
				world: boundWorld(),
				rooms: [{ ...boundRoom(ROOM_1), ...roomDelta }],
			});
			await expectDenyCode(
				runtime,
				makeDestination(),
				"MANAGE_SERVER_DESTINATION_UNBOUND",
			);
		},
	);

	it("denies when rooms exist but the agent shares none of them", async () => {
		const runtime = buildRuntime({
			world: boundWorld(),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [ROOM_1],
				[AGENT_ID]: [],
			},
		});
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED",
		);
	});

	it("denies when the requester's shared room lies outside the destination binding", async () => {
		const runtime = buildRuntime({
			world: boundWorld(),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [OTHER_WORLD_ROOM],
				[AGENT_ID]: [OTHER_WORLD_ROOM, ROOM_1],
			},
		});
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED",
		);
	});

	it("denies a USER-role requester who shares a destination room", async () => {
		const runtime = buildRuntime({
			world: boundWorld(roleMetadata(REQUESTER, "USER")),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [ROOM_1],
				[AGENT_ID]: [ROOM_1],
			},
		});
		await expectDenyCode(
			runtime,
			makeDestination(),
			"MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED",
		);
	});

	it("authorizes a metadata ADMIN with the exact shared binding rooms", async () => {
		const runtime = buildRuntime({
			world: boundWorld(roleMetadata(REQUESTER, "ADMIN")),
			rooms: [boundRoom(ROOM_1), boundRoom(ROOM_2)],
			participantRooms: {
				[REQUESTER]: [ROOM_2, ROOM_1],
				[AGENT_ID]: [ROOM_1, ROOM_2],
			},
		});
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER,
			makeDestination(),
		);
		expect(authorization.role).toBe("ADMIN");
		expect(authorization.requesterEntityId).toBe(REQUESTER);
		expect(authorization.authorizedEntityId).toBe(REQUESTER);
		expect([...authorization.bindingRoomIds].sort()).toEqual(
			[ROOM_1, ROOM_2].sort(),
		);
	});

	it("reports OWNER when the requester is the metadata ownership owner", async () => {
		const runtime = buildRuntime({
			world: boundWorld({ ownership: { ownerId: REQUESTER } }),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [ROOM_1],
				[AGENT_ID]: [ROOM_1],
			},
		});
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER,
			makeDestination(),
		);
		expect(authorization.role).toBe("OWNER");
		expect(authorization.authorizedEntityId).toBe(REQUESTER);
	});

	it("authorizes via a verified identity-cluster alias holding ADMIN", async () => {
		// Alias holds the ADMIN grant and the shared destination room; the
		// requester itself has neither. Verified cluster expansion must reach it.
		const runtime = buildRuntime({
			world: boundWorld(roleMetadata(ALIAS, "ADMIN")),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [],
				[ALIAS]: [ROOM_1],
				[AGENT_ID]: [ROOM_1],
			},
			services: {
				relationships: {
					getVerifiedMemberEntityIds: vi.fn(async () => [ALIAS]),
				},
			},
		});
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER,
			makeDestination(),
		);
		expect(authorization.role).toBe("ADMIN");
		expect(authorization.requesterEntityId).toBe(REQUESTER);
		expect(authorization.authorizedEntityId).toBe(ALIAS);
		expect(authorization.bindingRoomIds).toEqual([ROOM_1]);
	});

	it("drops the turn memo for the requester cluster before re-resolving", async () => {
		// Pre-warm the turn memo with a stale cluster ([REQUESTER] only, no
		// admin alias). Without the guard's invalidation call the stale memo
		// would deny; with it, the fresh resolution sees the alias and grants.
		let clusterMembers: UUID[] = [];
		const runtime = buildRuntime({
			world: boundWorld(roleMetadata(ALIAS, "ADMIN")),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [],
				[ALIAS]: [ROOM_1],
				[AGENT_ID]: [ROOM_1],
			},
			services: {
				relationships: {
					getVerifiedMemberEntityIds: vi.fn(async () => clusterMembers),
				},
			},
		});
		const inTurn = <T>(work: () => Promise<T>): Promise<T> =>
			runWithTrajectoryContext({ turnMemo: new Map() }, work) as Promise<T>;

		const authorization = await inTurn(async () => {
			// Stale snapshot: the resolver has not yet observed the alias.
			const stale = await getVerifiedRelatedEntityIds(runtime, REQUESTER);
			expect(stale).toEqual([REQUESTER]);

			clusterMembers = [ALIAS];
			return authorizeManageServerDestination(
				runtime,
				REQUESTER,
				makeDestination(),
			);
		});
		expect(authorization.authorizedEntityId).toBe(ALIAS);
	});

	it("continues past a USER-role cluster member to authorize a later ADMIN alias", async () => {
		// The requester comes first in the verified cluster but holds only USER
		// in the destination world; the guard must skip it and keep iterating
		// until the ADMIN alias is reached.
		const metadata = {
			roles: { [REQUESTER]: "USER", [ALIAS]: "ADMIN" },
			roleSources: { [REQUESTER]: "manual", [ALIAS]: "manual" },
		};
		const runtime = buildRuntime({
			world: boundWorld(metadata),
			rooms: [boundRoom(ROOM_1)],
			participantRooms: {
				[REQUESTER]: [ROOM_1],
				[ALIAS]: [ROOM_1],
				[AGENT_ID]: [ROOM_1],
			},
			services: {
				relationships: {
					getVerifiedMemberEntityIds: vi.fn(async () => [ALIAS]),
				},
			},
		});
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER,
			makeDestination(),
		);
		expect(authorization.role).toBe("ADMIN");
		expect(authorization.authorizedEntityId).toBe(ALIAS);
		expect(authorization.requesterEntityId).toBe(REQUESTER);
	});

	it("keeps the deny context carrying the requested destination fields", async () => {
		const runtime = buildRuntime({ world: null });
		let caught: unknown;
		try {
			await authorizeManageServerDestination(
				runtime,
				REQUESTER,
				makeDestination(),
			);
		} catch (error) {
			caught = error;
		}
		const elizaError = caught as { context?: Record<string, unknown> };
		// Note: the deny context carries source/accountId/serverId/
		// destinationWorldId — it deliberately does not repeat
		// messageServerId (verified against the module source).
		expect(elizaError.context).toMatchObject({
			source: "discord",
			accountId: "acct-1",
			serverId: "server-1",
			destinationWorldId: WORLD_ID,
		});
		expect(elizaError.context).not.toHaveProperty("messageServerId");
	});
});
