/**
 * TRUST update_role handler tests driving the real exported
 * `updateRoleHandler`: channel/server/world rejection gates, role-extraction
 * precedence (explicit parameters over model output), the OWNER-only
 * modification rule including same-role no-ops, and world-metadata
 * persistence with its single aggregated confirmation callback.
 */

import { describe, expect, it, vi } from "vitest";
import { ChannelType, Role } from "../../../types/index.ts";
import { updateRoleHandler } from "./roles.ts";

const ROOM_ID = "room-role-test";
const WORLD_ID = "world-role-test";
const REQUESTER_ID = "requester-entity";
const BOB_ID = "bob-entity";
const ALICE_ID = "alice-entity";

function buildEntity(id: string, names: string[]) {
	return { id, names };
}

interface FixtureOptions {
	worldMetadata?: Record<string, unknown> | undefined;
	modelOutput?: unknown;
	extraEntities?: Array<{ id: string; names: string[] }>;
}

function buildFixtures(options: FixtureOptions = {}) {
	const world = {
		id: WORLD_ID,
		name: "role-test-world",
		serverId: "server-role-test",
		metadata: options.worldMetadata as never,
	} as never;

	const entities = [
		buildEntity(REQUESTER_ID, ["Requester"]),
		buildEntity(BOB_ID, ["Bob"]),
		...(options.extraEntities ?? []),
	];

	const runtime = {
		getSetting: vi.fn((key: string) =>
			key === "WORLD_ID" ? WORLD_ID : undefined,
		),
		getWorld: vi.fn(async () => world),
		getEntitiesForRoom: vi.fn(async () => entities),
		dynamicPromptExecFromState: vi.fn(async () => options.modelOutput),
		updateWorld: vi.fn(async () => true),
	};

	const message = {
		entityId: REQUESTER_ID,
		roomId: ROOM_ID,
		content: {
			text: "make Bob an admin",
			channelType: ChannelType.GROUP,
			serverId: "server-role-test",
		},
	};

	const state = { text: "make Bob an admin" };

	const callback = vi.fn(async () => {});

	return {
		world,
		entities,
		runtime,
		message,
		state,
		callback,
		run: (extraOptions?: Record<string, unknown>) =>
			updateRoleHandler(
				runtime as never,
				message as never,
				state as never,
				extraOptions as never,
				callback as never,
			),
	};
}

describe("TRUST update_role", () => {
	it("throws when state is missing", async () => {
		const { runtime, message } = buildFixtures();
		await expect(
			updateRoleHandler(
				runtime as never,
				message as never,
				undefined,
				undefined,
			),
		).rejects.toThrow("State is required for role assignment");
	});

	it("rejects channels that are neither GROUP nor WORLD without touching the runtime", async () => {
		const fixtures = buildFixtures();
		fixtures.message.content.channelType = ChannelType.DM;

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"Role assignment only works in a group or world channel; tell the user roles can't be changed here.",
		);
		expect(result.data).toEqual({
			actionName: "TRUST",
			subaction: "update_role",
			success: false,
			error: "Unsupported channel type",
		});
		expect(fixtures.runtime.getWorld).not.toHaveBeenCalled();
		expect(fixtures.runtime.getEntitiesForRoom).not.toHaveBeenCalled();
		expect(fixtures.callback).not.toHaveBeenCalled();
	});

	it("rejects messages without a serverId before any world lookup", async () => {
		const fixtures = buildFixtures();
		delete fixtures.message.content.serverId;

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"Role assignment requires a serverId on the message; tell the user roles can't be changed from this channel.",
		);
		expect(result.data).toMatchObject({
			actionName: "TRUST",
			subaction: "update_role",
			success: false,
			error: "Missing serverId",
		});
		expect(fixtures.runtime.getEntitiesForRoom).not.toHaveBeenCalled();
		expect(fixtures.callback).not.toHaveBeenCalled();
	});

	it("fails with World not found when the configured world id resolves to nothing", async () => {
		const fixtures = buildFixtures();
		fixtures.runtime.getWorld.mockResolvedValue(null);

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"World not found; tell the user role assignment isn't available here.",
		);
		expect(result.data).toMatchObject({
			success: false,
			error: "World not found",
		});
		expect(fixtures.runtime.getWorld).toHaveBeenCalledWith(WORLD_ID);
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
		expect(fixtures.callback).not.toHaveBeenCalled();
	});

	it("fails with World not found without querying a world when WORLD_ID is unset", async () => {
		const fixtures = buildFixtures();
		fixtures.runtime.getSetting.mockReturnValue(undefined);

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({ error: "World not found" });
		expect(fixtures.runtime.getWorld).not.toHaveBeenCalled();
	});

	it("looks up room entities by the message roomId", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run();

		expect(fixtures.runtime.getEntitiesForRoom).toHaveBeenCalledWith(ROOM_ID);
		expect(result.success).toBe(true);
	});

	it("initializes missing world roles metadata and defaults the requester to NONE", async () => {
		const fixtures = buildFixtures({
			worldMetadata: {},
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"You don't have permission to change Bob's role to ADMIN.",
		);
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
	});

	it("prefers explicit parameter assignments over model output", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: [{ entityId: ALICE_ID, newRole: Role.NONE }],
			},
			extraEntities: [buildEntity(ALICE_ID, ["Alice"])],
		});

		const result = await fixtures.run({
			parameters: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			success: true,
			totalProcessed: 1,
			totalUpdated: 1,
			updatedRoles: [
				{ entityName: "Bob", entityId: BOB_ID, newRole: Role.ADMIN },
			],
		});
		expect(
			(fixtures.world as { metadata: { roles: Record<string, string> } })
				.metadata.roles,
		).toEqual({ [REQUESTER_ID]: Role.OWNER, [BOB_ID]: Role.ADMIN });
		expect(fixtures.runtime.updateWorld).toHaveBeenCalledTimes(1);
		expect(fixtures.runtime.updateWorld).toHaveBeenCalledWith(fixtures.world);
		expect(fixtures.runtime.dynamicPromptExecFromState).toHaveBeenCalledTimes(
			1,
		);
	});

	it("falls back to model output when every explicit assignment is invalid", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run({
			parameters: {
				roleAssignments: [
					{ entityId: "   ", newRole: Role.ADMIN },
					{ entityId: BOB_ID, newRole: "SUPREME_LEADER" },
					{ newRole: Role.ADMIN },
					{ entityId: 42, newRole: Role.ADMIN },
				],
			},
		});

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			totalProcessed: 1,
			totalUpdated: 1,
			updatedRoles: [
				{ entityName: "Bob", entityId: BOB_ID, newRole: Role.ADMIN },
			],
		});
	});

	it("trims entity ids and normalizes role casing from model output", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: [{ entityId: `  ${BOB_ID}  `, newRole: "admin" }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			updatedRoles: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
		});
	});

	it("finds assignments nested inside arrays and wrapper objects in model output", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: {
					batch: [
						{ note: "no fields here" },
						[
							{ entityId: BOB_ID, newRole: Role.ADMIN },
							{ entityId: ALICE_ID, newRole: Role.MEMBER },
						],
					],
				},
			},
			extraEntities: [buildEntity(ALICE_ID, ["Alice"])],
		});

		const result = await fixtures.run();

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			totalProcessed: 2,
			totalUpdated: 2,
			updatedRoles: [
				{ entityId: BOB_ID, newRole: Role.ADMIN },
				{ entityId: ALICE_ID, newRole: Role.MEMBER },
			],
		});
		expect(result.text).toBe(
			"Updated Bob's role to ADMIN.\nUpdated Alice's role to MEMBER.",
		);
	});

	it("reports no valid assignments when extraction yields nothing usable", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: null,
		});

		const result = await fixtures.run({
			parameters: { roleAssignments: [] },
		});

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"No valid role assignments found in the request; ask the user who should get which role.",
		);
		expect(result.data).toEqual({
			actionName: "TRUST",
			subaction: "update_role",
			success: false,
			message: "No valid role assignments found",
		});
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
		expect(fixtures.callback).not.toHaveBeenCalled();
	});

	it("skips assignments whose target entity is not in the room and updates nothing", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: [{ entityId: "stranger-entity", newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe("No roles were updated.");
		expect(result.data).toEqual({
			actionName: "TRUST",
			subaction: "update_role",
			success: false,
			updatedRoles: [],
			totalProcessed: 1,
			totalUpdated: 0,
		});
		expect(fixtures.world.metadata?.roles).not.toHaveProperty(
			"stranger-entity",
		);
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
		expect(fixtures.callback).not.toHaveBeenCalled();
	});

	it("denies a NONE-role requester even against a lower target role", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: {} },
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.MEMBER }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"You don't have permission to change Bob's role to MEMBER.",
		);
		expect(result.data).toMatchObject({
			success: false,
			totalProcessed: 1,
			totalUpdated: 0,
		});
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
		expect(fixtures.callback).not.toHaveBeenCalled();
	});

	it("denies an ADMIN requester because only OWNER may modify roles", async () => {
		const fixtures = buildFixtures({
			worldMetadata: {
				roles: { [REQUESTER_ID]: Role.ADMIN },
			},
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"You don't have permission to change Bob's role to ADMIN.",
		);
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
	});

	it("denies an OWNER modifying another OWNER because the target already holds the requester's role", async () => {
		const fixtures = buildFixtures({
			worldMetadata: {
				roles: { [REQUESTER_ID]: Role.OWNER, [ALICE_ID]: Role.OWNER },
			},
			modelOutput: {
				roleAssignments: [{ entityId: ALICE_ID, newRole: Role.MEMBER }],
			},
			extraEntities: [buildEntity(ALICE_ID, ["Alice"])],
		});

		const result = await fixtures.run();

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"You don't have permission to change Alice's role to MEMBER.",
		);
		expect(result.data).toMatchObject({
			success: false,
			totalProcessed: 1,
			totalUpdated: 0,
		});
		expect(fixtures.world.metadata?.roles?.[ALICE_ID]).toBe(Role.OWNER);
		expect(fixtures.runtime.updateWorld).not.toHaveBeenCalled();
	});

	it("allows an OWNER to re-assign the same role a non-owner target already holds", async () => {
		const fixtures = buildFixtures({
			worldMetadata: {
				roles: { [REQUESTER_ID]: Role.OWNER, [BOB_ID]: Role.ADMIN },
			},
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(true);
		expect(result.text).toBe("Updated Bob's role to ADMIN.");
		expect(result.data).toMatchObject({
			success: true,
			totalProcessed: 1,
			totalUpdated: 1,
		});
		expect(fixtures.world.metadata?.roles?.[BOB_ID]).toBe(Role.ADMIN);
		expect(fixtures.runtime.updateWorld).toHaveBeenCalledTimes(1);
	});

	it("persists an OWNER-granted role, fires one aggregated callback, and reports counts", async () => {
		const fixtures = buildFixtures({
			worldMetadata: { roles: { [REQUESTER_ID]: Role.OWNER } },
			modelOutput: {
				roleAssignments: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
			},
		});

		const result = await fixtures.run();

		expect(result.success).toBe(true);
		expect(result.text).toBe("Updated Bob's role to ADMIN.");
		expect(result.userFacingText).toBe("Updated Bob's role to ADMIN.");
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.data).toEqual({
			actionName: "TRUST",
			subaction: "update_role",
			success: true,
			updatedRoles: [
				{
					entityName: "Bob",
					entityId: BOB_ID,
					newRole: Role.ADMIN,
				},
			],
			totalProcessed: 1,
			totalUpdated: 1,
		});
		expect(fixtures.world.metadata?.roles?.[BOB_ID]).toBe(Role.ADMIN);
		expect(fixtures.runtime.updateWorld).toHaveBeenCalledTimes(1);
		expect(fixtures.runtime.updateWorld).toHaveBeenCalledWith(fixtures.world);
		expect(fixtures.callback).toHaveBeenCalledTimes(1);
		expect(fixtures.callback).toHaveBeenCalledWith({
			text: "Updated Bob's role to ADMIN.",
			actions: ["TRUST"],
			source: "discord",
		});
	});

	it("mixes applied and denied assignments in one aggregated reply", async () => {
		const fixtures = buildFixtures({
			worldMetadata: {
				roles: { [REQUESTER_ID]: Role.OWNER, [ALICE_ID]: Role.OWNER },
			},
			modelOutput: {
				roleAssignments: [
					{ entityId: BOB_ID, newRole: Role.ADMIN },
					{ entityId: ALICE_ID, newRole: Role.MEMBER },
				],
			},
			extraEntities: [buildEntity(ALICE_ID, ["Alice"])],
		});

		const result = await fixtures.run();

		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"Updated Bob's role to ADMIN.\nYou don't have permission to change Alice's role to MEMBER.",
		);
		expect(result.data).toMatchObject({
			success: true,
			totalProcessed: 2,
			totalUpdated: 1,
			updatedRoles: [{ entityId: BOB_ID, newRole: Role.ADMIN }],
		});
		expect(fixtures.world.metadata?.roles?.[ALICE_ID]).toBe(Role.OWNER);
		expect(fixtures.runtime.updateWorld).toHaveBeenCalledTimes(1);
	});
});
