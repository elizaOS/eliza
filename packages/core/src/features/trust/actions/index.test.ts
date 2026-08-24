/**
 * Exercises the actions barrel for the TRUST feature: every re-exported symbol
 * is live at runtime and the umbrella `trustAction` dispatches each structured
 * subaction into the real handler the barrel exports. Deterministic harness —
 * stub runtime services stand in for the trust engine and permission system;
 * all asserted behavior comes from executing the real modules under test.
 */

import { describe, expect, test, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	State,
	World,
} from "../../../types/index.ts";
import { ChannelType, Role } from "../../../types/index.ts";
import * as trustActions from "./index.ts";

const { trustAction } = trustActions;

const baseMessage = {
	id: "message-id",
	entityId: "sender-entity-id",
	roomId: "room-id",
	content: { text: "" },
} as Memory;

function runtimeWithServices(services: Record<string, unknown>): IAgentRuntime {
	return {
		agentId: "agent-id",
		getService: (name: string) => services[name] ?? null,
	} as unknown as IAgentRuntime;
}

const trustProfile = {
	entityId: "target-entity-id",
	dimensions: {
		reliability: 70,
		competence: 60,
		integrity: 65,
		benevolence: 55,
		transparency: 75,
	},
	overallTrust: 65,
	confidence: 0.8,
	interactionCount: 42,
	evidence: [],
	lastCalculated: 0,
	calculationMethod: "test",
	trend: { direction: "stable", changeRate: 0, lastChangeAt: 0 },
	evaluatorId: "agent-id",
};

describe("TRUST actions barrel surface", () => {
	test("aggregates the complete live action surface in export order", () => {
		expect(Object.keys(trustActions)).toEqual([
			"evaluateTrustHandler",
			"hasTrustEngine",
			"recordTrustInteractionHandler",
			"requestElevationHandler",
			"updateRoleHandler",
			"trustAction",
		]);
		expect(typeof trustActions.evaluateTrustHandler).toBe("function");
		expect(typeof trustActions.hasTrustEngine).toBe("function");
		expect(typeof trustActions.recordTrustInteractionHandler).toBe("function");
		expect(typeof trustActions.requestElevationHandler).toBe("function");
		expect(typeof trustActions.updateRoleHandler).toBe("function");
		expect(trustAction.name).toBe("TRUST");
	});

	test("reports availability from the live trust-engine registration", () => {
		expect(trustActions.hasTrustEngine(runtimeWithServices({}))).toBe(false);
		const trustEngine = { trustEngine: {} };
		expect(
			trustActions.hasTrustEngine(
				runtimeWithServices({ "trust-engine": trustEngine }),
			),
		).toBe(true);
	});
});

describe("barrel umbrella dispatch into the exported handlers", () => {
	test("missing subaction fails with the umbrella guidance", async () => {
		const result = await trustAction.handler(
			runtimeWithServices({}),
			baseMessage,
			undefined,
			undefined,
		);

		expect(result).toEqual({
			success: false,
			text: "Specify a trust action: evaluate, record_interaction, request_elevation, or update_role.",
			error: "Missing trust subaction",
			data: { actionName: "TRUST" },
		});
	});

	test("evaluate reads the injected engine profile and defaults the target to the sender", async () => {
		const evaluateTrust = vi.fn(async () => trustProfile);
		const runtime = runtimeWithServices({
			"trust-engine": { trustEngine: { evaluateTrust } },
		});

		const result = await trustAction.handler(
			runtime,
			baseMessage,
			{},
			{
				parameters: { action: "evaluate" },
			},
		);

		expect(evaluateTrust).toHaveBeenCalledWith("sender-entity-id", "agent-id", {
			evaluatorId: "agent-id",
			roomId: "room-id",
		});
		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"Trust Level: Good (65/100) based on 42 interactions",
		);
		expect(result.data).toMatchObject({
			actionName: "TRUST",
			subaction: "evaluate",
			trustScore: 65,
			trustLevel: "Good",
			confidence: 0.8,
		});
	});

	test("evaluate rejects a name-only lookup routed through the umbrella", async () => {
		const runtime = runtimeWithServices({
			"trust-engine": {
				trustEngine: { evaluateTrust: vi.fn(async () => trustProfile) },
			},
		});

		const result = await trustAction.handler(
			runtime,
			baseMessage,
			{},
			{
				parameters: { action: "evaluate", entityName: "Alice" },
			},
		);

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			actionName: "TRUST",
			subaction: "evaluate",
			reason: "entity_id_required",
		});
	});

	test("record_interaction normalizes the evidence type and defaults the target to the agent", async () => {
		const recordInteraction = vi.fn(async () => undefined);
		const runtime = runtimeWithServices({
			"trust-engine": { trustEngine: { recordInteraction } },
		});

		const result = await trustAction.handler(
			runtime,
			baseMessage,
			{},
			{
				parameters: {
					action: "record_interaction",
					type: "promise_kept",
					impact: 15,
				},
			},
		);

		expect(recordInteraction).toHaveBeenCalledTimes(1);
		const [interaction] = recordInteraction.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(interaction).toMatchObject({
			sourceEntityId: "sender-entity-id",
			targetEntityId: "agent-id",
			type: "PROMISE_KEPT",
			impact: 15,
		});
		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"Trust interaction recorded: PROMISE_KEPT with impact +15",
		);
	});

	test("request_elevation grants through the permission system and echoes the expiry", async () => {
		const expiresAt = 1893456000000;
		const requestElevation = vi.fn(async () => ({
			granted: true,
			expiresAt,
		}));
		const runtime = runtimeWithServices({
			"contextual-permissions": { permissionSystem: { requestElevation } },
			"trust-engine": {
				trustEngine: { evaluateTrust: vi.fn(async () => trustProfile) },
			},
		});

		const result = await trustAction.handler(
			runtime,
			baseMessage,
			{},
			{
				parameters: {
					action: "request_elevation",
					permissionAction: "manage_roles",
				},
			},
		);

		expect(requestElevation).toHaveBeenCalledTimes(1);
		const [elevationRequest] = requestElevation.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(elevationRequest).toMatchObject({
			entityId: "sender-entity-id",
			requestedPermission: { action: "manage_roles", resource: "*" },
			duration: 3600000,
		});
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			actionName: "TRUST",
			subaction: "request_elevation",
			approved: true,
			expiresAt,
		});
	});

	test("request_elevation without a permission action fails before contacting services", async () => {
		const requestElevation = vi.fn(async () => ({ granted: true }));
		const runtime = runtimeWithServices({
			"contextual-permissions": { permissionSystem: { requestElevation } },
			"trust-engine": {
				trustEngine: { evaluateTrust: vi.fn(async () => trustProfile) },
			},
		});

		const result = await trustAction.handler(
			runtime,
			baseMessage,
			{},
			{
				parameters: {
					action: "request_elevation",
					resource: "channel:general",
				},
			},
		);

		expect(requestElevation).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			actionName: "TRUST",
			subaction: "request_elevation",
		});
	});

	test("update_role applies an explicit OWNER-granted assignment to the world", async () => {
		const world = {
			id: "world-1",
			metadata: { roles: { "sender-entity-id": Role.OWNER } },
		};
		const updatedWorlds: World[] = [];
		const runtime = runtimeWithServices({});
		(runtime as unknown as Record<string, unknown>).getSetting = () =>
			"world-1";
		(runtime as unknown as Record<string, unknown>).getWorld = async (
			worldId: string,
		) => (worldId === "world-1" ? world : null);
		(runtime as unknown as Record<string, unknown>).getEntitiesForRoom =
			async () => [{ id: "bob-entity-id", names: ["Bob"] }];
		(runtime as unknown as Record<string, unknown>).dynamicPromptExecFromState =
			async () => ({ roleAssignments: [] });
		(runtime as unknown as Record<string, unknown>).updateWorld = async (
			updated: World,
		) => {
			updatedWorlds.push(updated);
		};
		const groupMessage = {
			id: "message-id",
			entityId: "sender-entity-id",
			roomId: "room-id",
			content: {
				text: "",
				channelType: ChannelType.GROUP,
				serverId: "server-1",
			},
		} as Memory;
		const callback = vi.fn(async () => undefined);

		const result = await trustAction.handler(
			runtime,
			groupMessage,
			{ text: "make Bob an admin" } as unknown as State,
			{
				parameters: {
					action: "update_role",
					roleAssignments: [{ entityId: "bob-entity-id", newRole: "ADMIN" }],
				},
			},
			callback,
		);

		expect(result.success).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.data).toMatchObject({
			actionName: "TRUST",
			subaction: "update_role",
			totalProcessed: 1,
			totalUpdated: 1,
			updatedRoles: [
				{
					entityName: "Bob",
					entityId: "bob-entity-id",
					newRole: Role.ADMIN,
				},
			],
		});
		expect(world.metadata?.roles["bob-entity-id"]).toBe(Role.ADMIN);
		expect(updatedWorlds).toHaveLength(1);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback.mock.calls[0][0]).toMatchObject({
			text: "Updated Bob's role to ADMIN.",
			actions: ["TRUST"],
		});
	});
});
