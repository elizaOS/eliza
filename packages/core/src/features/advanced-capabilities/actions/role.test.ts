/**
 * Deterministic unit coverage for the ROLE action's public validation, target
 * resolution, role normalization, hierarchy enforcement, mutation, and list
 * behavior. The harness uses in-memory rooms, worlds, entities, and messages;
 * no model, database, or mocked module stands in for the action under test.
 */

import { describe, expect, it } from "vitest";
import type { Entity, Room, World } from "../../../types/environment.ts";
import type {
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { looksLikeRoleIntent, roleAction, updateRoleAction } from "./role.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ADMIN_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const OTHER_ID = "00000000-0000-0000-0000-000000000005" as UUID;
const OUTSIDER_ID = "00000000-0000-0000-0000-000000000006" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000010" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000020" as UUID;

type RoleValue = "OWNER" | "ADMIN" | "USER" | "GUEST";

interface HarnessOptions {
	requesterId?: UUID;
	room?: Room | null;
	world?: World | null;
	entities?: Entity[];
	roomEntityIds?: UUID[];
	memories?: Memory[];
}

function entity(
	id: UUID,
	names: string[],
	metadata?: Entity["metadata"],
): Entity {
	return { id, names, agentId: AGENT_ID, metadata };
}

function makeMessage(
	requesterId: UUID = OWNER_ID,
	content: Partial<Content> = {},
): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000030" as UUID,
		agentId: AGENT_ID,
		entityId: requesterId,
		roomId: ROOM_ID,
		content: {
			text: "manage roles",
			source: "test",
			channelType: ChannelType.GROUP,
			...content,
		},
		createdAt: 1,
	} as Memory;
}

function makeHarness(options: HarnessOptions = {}) {
	const defaultWorld = {
		id: WORLD_ID,
		agentId: AGENT_ID,
		name: "Test World",
		metadata: {
			ownership: { ownerId: OWNER_ID },
			roles: { [OWNER_ID]: "OWNER" },
			roleSources: { [OWNER_ID]: "owner" },
		},
	} as World;
	const defaultRoom = {
		id: ROOM_ID,
		agentId: AGENT_ID,
		name: "roles",
		source: "test",
		type: ChannelType.GROUP,
		messageServerId: "00000000-0000-0000-0000-000000000040" as UUID,
		worldId: WORLD_ID,
	} as Room;
	const world = options.world === undefined ? defaultWorld : options.world;
	const room = options.room === undefined ? defaultRoom : options.room;
	const entities = new Map<UUID, Entity>(
		(
			options.entities ?? [
				entity(OWNER_ID, ["Owner"]),
				entity(ADMIN_ID, ["Alex Admin"]),
				entity(USER_ID, ["Pat User"]),
				entity(OTHER_ID, ["Other User"]),
			]
		).map((value) => [value.id as UUID, value]),
	);
	const roomEntityIds = options.roomEntityIds ?? [...entities.keys()];
	const callbacks: Content[] = [];
	let updateCount = 0;
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		getSetting: (key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : null,
		getRoom: async (id: UUID) => (id === ROOM_ID ? room : null),
		getWorld: async (id: UUID) => (id === WORLD_ID ? world : null),
		updateWorld: async () => {
			updateCount += 1;
		},
		getEntitiesForRoom: async () =>
			roomEntityIds
				.map((id) => entities.get(id))
				.filter((value): value is Entity => value !== undefined),
		getEntityById: async (id: UUID) => entities.get(id) ?? null,
		getMemoriesByRoomIds: async () => options.memories ?? [],
		getRelationships: async () => [],
		reportError: () => {},
	} as unknown as IAgentRuntime;
	const callback: HandlerCallback = async (content) => {
		callbacks.push(content);
		return [];
	};

	return {
		runtime,
		message: makeMessage(options.requesterId),
		world,
		callbacks,
		callback,
		get updateCount() {
			return updateCount;
		},
	};
}

function parameters(values: Record<string, unknown>): HandlerOptions {
	return { parameters: values } as HandlerOptions;
}

function rolesOf(world: World | null): Record<string, RoleValue> {
	return (world?.metadata?.roles ?? {}) as Record<string, RoleValue>;
}

describe("ROLE exports and intent detection", () => {
	it("keeps updateRoleAction as the same backwards-compatible action", () => {
		expect(updateRoleAction).toBe(roleAction);
		expect(roleAction.name).toBe("ROLE");
		expect(roleAction.roleGate).toEqual({ minRole: "OWNER" });
	});

	it("matches configured role phrases without matching empty or partial words", () => {
		expect(looksLikeRoleIntent("Please assign role to Pat")).toBe(true);
		expect(looksLikeRoleIntent("PROMOTE Pat")).toBe(true);
		expect(looksLikeRoleIntent("  ")).toBe(false);
		expect(looksLikeRoleIntent("This is a parole request")).toBe(false);
	});
});

describe("ROLE validation", () => {
	it("accepts GROUP and WORLD rooms with a message server", async () => {
		const group = makeHarness();
		const world = makeHarness();
		world.message.content.channelType = ChannelType.WORLD;

		expect(await roleAction.validate(group.runtime, group.message)).toBe(true);
		expect(await roleAction.validate(world.runtime, world.message)).toBe(true);
	});

	it("rejects direct channels and rooms without a message server", async () => {
		const direct = makeHarness();
		direct.message.content.channelType = ChannelType.DM;
		const noServerRoom = makeHarness({
			room: {
				id: ROOM_ID,
				source: "test",
				type: ChannelType.GROUP,
				worldId: WORLD_ID,
			},
		});

		expect(await roleAction.validate(direct.runtime, direct.message)).toBe(
			false,
		);
		expect(
			await roleAction.validate(noServerRoom.runtime, noServerRoom.message),
		).toBe(false);
	});

	it("uses room state when supplied instead of requiring a room lookup result", async () => {
		const harness = makeHarness({ room: null });
		const state = {
			data: { room: { id: ROOM_ID, messageServerId: "server-from-state" } },
		} as unknown as State;

		expect(
			await roleAction.validate(harness.runtime, harness.message, state),
		).toBe(true);
	});
});

describe("ROLE list operation", () => {
	it("returns an explicit empty state and invokes the callback", async () => {
		const harness = makeHarness();
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {};
		}

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ subaction: "get" }),
			harness.callback,
		);

		expect(result).toMatchObject({
			success: true,
			text: "No role assignments.",
			values: { roleCount: 0 },
			data: { actionName: "ROLE", op: "list", roles: {} },
		});
		expect(harness.callbacks).toEqual([
			{ text: "No role assignments.", actions: ["ROLE"] },
		]);
	});

	it("renders entity display names and falls back to an unknown entity id", async () => {
		const harness = makeHarness();
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {
				[USER_ID]: "ADMIN",
				[OUTSIDER_ID]: "GUEST",
			};
		}

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ action: "list" }),
		);

		expect(result.text).toBe(`Pat User: ADMIN\n${OUTSIDER_ID}: GUEST`);
		expect(result.values).toEqual({ roleCount: 2 });
	});

	it("fails closed when the message has no world context", async () => {
		const harness = makeHarness({ room: null });

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ action: "list" }),
		);

		expect(result).toMatchObject({
			success: false,
			error: "WORLD_NOT_FOUND",
			data: { actionName: "ROLE", op: "list" },
		});
	});
});

describe("ROLE assignment parameter normalization", () => {
	it("accepts structured assignments from message content and natural role aliases", async () => {
		const harness = makeHarness();
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {
				[OWNER_ID]: "OWNER",
				[OTHER_ID]: "USER",
			};
			harness.world.metadata.roleSources = {
				[OWNER_ID]: "owner",
				[OTHER_ID]: "manual",
			};
		}
		harness.message.content.assignments = [
			{ entityId: USER_ID, newRole: "moderator" },
			{ entityId: OTHER_ID, newRole: "member" },
		];

		const result = await roleAction.handler(harness.runtime, harness.message);

		expect(result).toMatchObject({
			success: true,
			values: { successCount: 2, failureCount: 0 },
		});
		expect(rolesOf(harness.world)).toMatchObject({
			[USER_ID]: "ADMIN",
			[OTHER_ID]: "GUEST",
		});
		expect(harness.updateCount).toBe(2);
	});

	it("revoke defaults every valid batch target to GUEST", async () => {
		const harness = makeHarness();
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {
				[OWNER_ID]: "OWNER",
				[ADMIN_ID]: "ADMIN",
				[USER_ID]: "USER",
			};
			harness.world.metadata.roleSources = {
				[OWNER_ID]: "owner",
				[ADMIN_ID]: "manual",
				[USER_ID]: "manual",
			};
		}

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				op: "remove",
				assignments: [{ entityId: ADMIN_ID }, { entityId: USER_ID }],
			}),
		);

		expect(result.values).toEqual({ successCount: 2, failureCount: 0 });
		expect(rolesOf(harness.world)).toMatchObject({
			[ADMIN_ID]: "GUEST",
			[USER_ID]: "GUEST",
		});
	});

	it("rejects malformed or incomplete assignment arrays without mutating", async () => {
		const harness = makeHarness();

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "assign",
				assignments: [null, "bad", { newRole: "ADMIN" }, { entityId: USER_ID }],
			}),
		);

		expect(result).toMatchObject({
			success: false,
			error: "ROLE_ASSIGN_FAILED",
		});
		expect(result.data).toMatchObject({
			errors: ["Assignment missing entityId", `Invalid role for ${USER_ID}`],
		});
		expect(harness.updateCount).toBe(0);
	});

	it("splits empty assign and revoke failures by operation error code", async () => {
		const assignHarness = makeHarness();
		const revokeHarness = makeHarness();
		const expectedText =
			"No valid role assignments derived from the request; ask the user who to change and to what role.";

		const assignResult = await roleAction.handler(
			assignHarness.runtime,
			assignHarness.message,
		);
		const revokeResult = await roleAction.handler(
			revokeHarness.runtime,
			revokeHarness.message,
			undefined,
			parameters({ mode: "revoke" }),
		);

		expect(assignResult).toMatchObject({
			success: false,
			error: "ROLE_ASSIGN_FAILED",
			text: expectedText,
			data: { op: "assign", errors: [] },
		});
		expect(revokeResult).toMatchObject({
			success: false,
			error: "ROLE_REVOKE_FAILED",
			text: expectedText,
			data: { op: "revoke", errors: [] },
		});
		expect(assignHarness.updateCount).toBe(0);
		expect(revokeHarness.updateCount).toBe(0);
	});

	it("observes the current fallback: an unknown operation defaults to assign", async () => {
		const harness = makeHarness();

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "unexpected",
				assignments: [{ entityId: USER_ID, newRole: "USER" }],
			}),
		);

		expect(result).toMatchObject({
			success: true,
			data: { op: "assign" },
		});
		expect(rolesOf(harness.world)[USER_ID]).toBe("USER");
	});
});

describe("ROLE single-target resolution", () => {
	it("normalizes mention punctuation and resolves a metadata alias", async () => {
		const harness = makeHarness({
			entities: [
				entity(OWNER_ID, ["Owner"]),
				entity(USER_ID, ["Patricia"], {
					discord: { username: "pat", displayName: "Pat User" },
				}),
			],
		});

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ action: "promote", target: "  @pat! ", role: "mod" }),
		);

		expect(result.success).toBe(true);
		expect(rolesOf(harness.world)[USER_ID]).toBe("ADMIN");
	});

	it("prefers the otherwise tied candidate who spoke recently", async () => {
		const recent = {
			...makeMessage(OTHER_ID),
			id: "00000000-0000-0000-0000-000000000031" as UUID,
			createdAt: 99,
		};
		const harness = makeHarness({
			entities: [
				entity(OWNER_ID, ["Owner"]),
				entity(USER_ID, ["Sam"]),
				entity(OTHER_ID, ["Sam"]),
			],
			memories: [recent],
		});

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ action: "assign", target: "Sam", role: "USER" }),
		);

		expect(result.success).toBe(true);
		expect(rolesOf(harness.world)[OTHER_ID]).toBe("USER");
		expect(rolesOf(harness.world)[USER_ID]).toBeUndefined();
	});

	it("resolves a recent speaker absent from the current-room entity list", async () => {
		const recent = {
			...makeMessage(OUTSIDER_ID),
			id: "00000000-0000-0000-0000-000000000032" as UUID,
			createdAt: 101,
		};
		const harness = makeHarness({
			entities: [
				entity(OWNER_ID, ["Owner"]),
				entity(OUTSIDER_ID, ["Remote Pat"]),
			],
			roomEntityIds: [OWNER_ID],
			memories: [recent],
		});

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ action: "assign", user: "Remote Pat", role: "USER" }),
		);

		expect(result).toMatchObject({
			success: true,
			values: { successCount: 1, failureCount: 0 },
		});
		expect(rolesOf(harness.world)[OUTSIDER_ID]).toBe("USER");
		expect(harness.updateCount).toBe(1);
	});

	it("rejects tied candidates when the ranking gap is below the ambiguity threshold", async () => {
		const harness = makeHarness({
			entities: [
				entity(OWNER_ID, ["Owner"]),
				entity(USER_ID, ["Alex"]),
				entity(OTHER_ID, ["Alex"]),
			],
		});

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({ action: "assign", target: "Alex", role: "USER" }),
		);

		expect(result).toMatchObject({
			success: false,
			error: "ROLE_ASSIGN_FAILED",
			text: 'Multiple possible matches for "Alex". Use a more specific name.',
		});
		expect(harness.updateCount).toBe(0);
	});

	it("rejects missing names, pronouns, overlong names, and unknown labels", async () => {
		const targets = [
			{ target: "Nobody", role: "USER", reason: "Could not find user" },
			{
				target: "@them",
				role: "USER",
				reason: "Could not determine target user",
			},
			{
				target: "x".repeat(65),
				role: "USER",
				reason: "Could not determine target user",
			},
			{
				target: "Pat User",
				label: "wizard",
				reason: "Could not determine target role",
			},
		];

		for (const target of targets) {
			const harness = makeHarness();
			const result = await roleAction.handler(
				harness.runtime,
				harness.message,
				undefined,
				parameters({ action: "assign", ...target, reason: undefined }),
			);
			expect(result.success).toBe(false);
			expect(result.text).toContain(target.reason);
			expect(harness.updateCount).toBe(0);
		}
	});
});

describe("ROLE hierarchy and mutation outcomes", () => {
	it("rejects a non-owner requester even when their stored role is ADMIN", async () => {
		const harness = makeHarness({ requesterId: ADMIN_ID });
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {
				[OWNER_ID]: "OWNER",
				[ADMIN_ID]: "ADMIN",
			};
			harness.world.metadata.roleSources = {
				[OWNER_ID]: "owner",
				[ADMIN_ID]: "manual",
			};
		}

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "assign",
				assignments: [{ entityId: USER_ID, newRole: "USER" }],
			}),
		);

		expect(result).toMatchObject({
			success: false,
			error: "INSUFFICIENT_PERMISSIONS",
			data: { requesterRole: "ADMIN" },
		});
		expect(harness.updateCount).toBe(0);
	});

	it("protects the agent, canonical OWNER slot, last OWNER, and no-op assignments", async () => {
		const harness = makeHarness();
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {
				[OWNER_ID]: "OWNER",
				[USER_ID]: "USER",
			};
			harness.world.metadata.roleSources = {
				[OWNER_ID]: "owner",
				[USER_ID]: "manual",
			};
		}

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "assign",
				assignments: [
					{ entityId: AGENT_ID, newRole: "USER" },
					{ entityId: OTHER_ID, newRole: "OWNER" },
					{ entityId: OWNER_ID, newRole: "USER" },
					{ entityId: USER_ID, newRole: "USER" },
				],
			}),
			harness.callback,
		);

		expect(result).toMatchObject({
			success: false,
			text: "Updated 0 roles; 4 failed.",
			values: { successCount: 0, failureCount: 4 },
		});
		expect(harness.callbacks).toEqual([
			{ text: "Updated 0 roles; 4 failed.", actions: ["ROLE"] },
		]);
		expect(harness.updateCount).toBe(0);
	});

	it("allows the requester to demote itself when another OWNER remains", async () => {
		const harness = makeHarness();
		if (harness.world?.metadata) {
			harness.world.metadata.roles = {
				[OWNER_ID]: "OWNER",
				[OTHER_ID]: "OWNER",
			};
			harness.world.metadata.roleSources = {
				[OWNER_ID]: "owner",
				[OTHER_ID]: "manual",
			};
		}

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "assign",
				assignments: [{ entityId: OWNER_ID, newRole: "USER" }],
			}),
		);

		expect(result).toMatchObject({
			success: true,
			values: { successCount: 1, failureCount: 0 },
		});
		expect(rolesOf(harness.world)).toMatchObject({
			[OWNER_ID]: "USER",
			[OTHER_ID]: "OWNER",
		});
		expect(harness.updateCount).toBe(1);
	});

	it("reports partial batch success and mutates only permitted assignments", async () => {
		const harness = makeHarness();

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "assign",
				assignments: [
					{ entityId: USER_ID, newRole: "ADMIN" },
					{ entityId: AGENT_ID, newRole: "USER" },
				],
			}),
			harness.callback,
		);

		expect(result).toMatchObject({
			success: true,
			text: "Updated 1 role; 1 failed.",
			verifiedUserFacing: true,
			turnComplete: true,
			values: { successCount: 1, failureCount: 1 },
			data: { worldId: WORLD_ID },
		});
		expect(rolesOf(harness.world)[USER_ID]).toBe("ADMIN");
		expect(harness.updateCount).toBe(1);
	});

	it("fails assignment before mutation when the world cannot be resolved", async () => {
		const harness = makeHarness({ world: null });

		const result = await roleAction.handler(
			harness.runtime,
			harness.message,
			undefined,
			parameters({
				action: "assign",
				assignments: [{ entityId: USER_ID, newRole: "USER" }],
			}),
		);

		expect(result).toMatchObject({
			success: false,
			error: "WORLD_NOT_FOUND",
			data: { actionName: "ROLE", op: "assign" },
		});
		expect(harness.updateCount).toBe(0);
	});
});
