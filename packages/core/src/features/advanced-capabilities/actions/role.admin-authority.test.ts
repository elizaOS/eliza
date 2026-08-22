/**
 * Verifies the real ROLE action admits ADMIN callers while its assignment
 * hierarchy prevents peer, owner, self, and OWNER-grant escalation.
 */

import { describe, expect, it, vi } from "vitest";
import { canActionRun } from "../../../runtime/action-gate.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../../runtime/default-contexts.ts";
import type {
	IAgentRuntime,
	Memory,
	UUID,
	World,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { roleAction } from "./role.ts";

const IDS = {
	agent: "00000000-0000-4000-8000-000000000001" as UUID,
	admin: "00000000-0000-4000-8000-000000000002" as UUID,
	owner: "00000000-0000-4000-8000-000000000003" as UUID,
	peerAdmin: "00000000-0000-4000-8000-000000000004" as UUID,
	user: "00000000-0000-4000-8000-000000000005" as UUID,
	guest: "00000000-0000-4000-8000-000000000006" as UUID,
	room: "00000000-0000-4000-8000-000000000007" as UUID,
	world: "00000000-0000-4000-8000-000000000008" as UUID,
} as const;

function harness(actor: "OWNER" | "ADMIN" | "USER" = "ADMIN") {
	const actorId =
		actor === "OWNER" ? IDS.owner : actor === "USER" ? IDS.user : IDS.admin;
	const world = {
		id: IDS.world,
		agentId: IDS.agent,
		name: "Test world",
		serverId: "test",
		metadata: {
			ownership: { ownerId: IDS.owner },
			roles: {
				[IDS.owner]: "OWNER",
				[IDS.admin]: "ADMIN",
				[IDS.peerAdmin]: "ADMIN",
				[IDS.user]: "USER",
				[IDS.guest]: "GUEST",
			},
			roleSources: {
				[IDS.owner]: "owner",
				[IDS.admin]: "manual",
				[IDS.peerAdmin]: "manual",
				[IDS.user]: "manual",
			},
		},
	} as unknown as World;
	const updateWorld = vi.fn(async () => undefined);
	const getWorld = vi.fn(async () => world);
	const runtime = {
		agentId: IDS.agent,
		getRoom: vi.fn(async () => ({
			id: IDS.room,
			worldId: IDS.world,
			messageServerId: "test",
		})),
		getWorld,
		updateWorld,
	} as unknown as IAgentRuntime;
	const message = {
		id: "00000000-0000-4000-8000-000000000009" as UUID,
		entityId: actorId,
		agentId: IDS.agent,
		roomId: IDS.room,
		content: { text: "manage roles", channelType: ChannelType.GROUP },
		createdAt: Date.now(),
	} as Memory;
	return { getWorld, message, runtime, updateWorld, world };
}

async function assign(
	target: UUID,
	newRole: string,
	actor: "OWNER" | "ADMIN" | "USER" = "ADMIN",
) {
	const test = harness(actor);
	const result = await roleAction.handler(
		test.runtime,
		test.message,
		undefined,
		{
			parameters: {
				action: "assign",
				assignments: [{ entityId: target, newRole }],
			},
		},
	);
	return { ...test, result };
}

async function list(actor: "OWNER" | "ADMIN" | "USER") {
	const test = harness(actor);
	const result = await roleAction.handler(
		test.runtime,
		test.message,
		undefined,
		{ parameters: { action: "list" } },
	);
	return { ...test, result };
}

describe("ROLE bounded ADMIN authority", () => {
	it("advertises ADMIN as the minimum role", () => {
		expect(roleAction.roleGate).toEqual({ minRole: "ADMIN" });
	});

	it("uses the shared action gate through settings without broadening admin context", () => {
		expect(
			canActionRun(roleAction, {
				message: harness().message,
				activeContexts: ["settings"],
				userRoles: ["ADMIN"],
			}),
		).toBe(true);
		expect(
			canActionRun(roleAction, {
				message: harness("USER").message,
				activeContexts: ["settings"],
				userRoles: ["USER"],
			}),
		).toBe(false);
		expect(
			DEFAULT_CONTEXT_DEFINITIONS.find(({ id }) => id === "settings")?.roleGate,
		).toEqual({ minRole: "ADMIN" });
		expect(
			DEFAULT_CONTEXT_DEFINITIONS.find(({ id }) => id === "admin")?.roleGate,
		).toEqual({ minRole: "OWNER" });
	});

	it("allows ADMIN to promote a lower-ranked USER to ADMIN", async () => {
		const { result, updateWorld, world } = await assign(IDS.user, "ADMIN");

		expect(result).toMatchObject({
			success: true,
			values: { successCount: 1 },
		});
		expect(updateWorld).toHaveBeenCalledTimes(1);
		expect(
			(world.metadata as { roles: Record<string, string> }).roles[IDS.user],
		).toBe("ADMIN");
	});

	it("retains OWNER management of lower-ranked participants", async () => {
		const { result, updateWorld } = await assign(IDS.user, "ADMIN", "OWNER");

		expect(result).toMatchObject({
			success: true,
			values: { successCount: 1 },
		});
		expect(updateWorld).toHaveBeenCalledTimes(1);
	});

	it("fails closed when a lower-ranked caller reaches the handler directly", async () => {
		const { result, updateWorld } = await assign(IDS.guest, "USER", "USER");

		expect(result).toMatchObject({
			success: false,
			error: "INSUFFICIENT_PERMISSIONS",
			data: { requesterRole: "USER" },
		});
		expect(updateWorld).not.toHaveBeenCalled();
	});

	it("denies a lower-ranked direct list before exposing role assignments", async () => {
		const { result, updateWorld } = await list("USER");

		expect(result).toMatchObject({
			success: false,
			error: "INSUFFICIENT_PERMISSIONS",
			data: { op: "list", requesterRole: "USER" },
		});
		expect(result.text).not.toContain(IDS.owner);
		expect(updateWorld).not.toHaveBeenCalled();
	});

	it("rechecks ADMIN authority immediately before a role write", async () => {
		const test = harness();
		const revokedWorld = {
			...test.world,
			metadata: {
				...test.world.metadata,
				roles: {
					...(test.world.metadata as { roles: Record<string, string> }).roles,
					[IDS.admin]: "USER",
				},
			},
		} as World;
		test.getWorld
			.mockResolvedValueOnce(test.world)
			.mockResolvedValueOnce(revokedWorld);

		const result = await roleAction.handler(
			test.runtime,
			test.message,
			undefined,
			{
				parameters: {
					action: "assign",
					assignments: [{ entityId: IDS.guest, newRole: "USER" }],
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "INSUFFICIENT_PERMISSIONS",
			data: { requesterRole: "USER" },
		});
		expect(test.getWorld).toHaveBeenCalledTimes(2);
		expect(test.updateWorld).not.toHaveBeenCalled();
	});

	it("writes the exact authorized snapshot without a hidden world refetch", async () => {
		const test = harness();
		const authorizedWorld = structuredClone(test.world) as World;
		const revokedWorld = {
			...structuredClone(test.world),
			metadata: {
				...structuredClone(test.world.metadata),
				roles: {
					...(test.world.metadata as { roles: Record<string, string> }).roles,
					[IDS.admin]: "USER",
				},
			},
		} as World;
		test.getWorld
			.mockResolvedValueOnce(test.world)
			.mockResolvedValueOnce(authorizedWorld)
			.mockResolvedValueOnce(revokedWorld);

		const result = await roleAction.handler(
			test.runtime,
			test.message,
			undefined,
			{
				parameters: {
					action: "assign",
					assignments: [{ entityId: IDS.guest, newRole: "USER" }],
				},
			},
		);

		expect(result).toMatchObject({ success: true });
		expect(test.getWorld).toHaveBeenCalledTimes(2);
		expect(test.updateWorld).toHaveBeenCalledWith(authorizedWorld);
		expect(
			(authorizedWorld.metadata as { roles: Record<string, string> }).roles[
				IDS.guest
			],
		).toBe("USER");
	});

	it("reauthorizes between batch writes and stops after a concurrent demotion", async () => {
		const test = harness();
		const authorizedWorld = structuredClone(test.world) as World;
		const revokedWorld = {
			...structuredClone(test.world),
			metadata: {
				...structuredClone(test.world.metadata),
				roles: {
					...(test.world.metadata as { roles: Record<string, string> }).roles,
					[IDS.admin]: "USER",
				},
			},
		} as World;
		test.getWorld
			.mockResolvedValueOnce(test.world)
			.mockResolvedValueOnce(authorizedWorld)
			.mockResolvedValueOnce(revokedWorld);

		const result = await roleAction.handler(
			test.runtime,
			test.message,
			undefined,
			{
				parameters: {
					action: "assign",
					assignments: [
						{ entityId: IDS.guest, newRole: "USER" },
						{ entityId: IDS.user, newRole: "ADMIN" },
					],
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "INSUFFICIENT_PERMISSIONS",
			data: { requesterRole: "USER" },
		});
		expect(test.getWorld).toHaveBeenCalledTimes(3);
		expect(test.updateWorld).toHaveBeenCalledTimes(1);
		expect(
			(authorizedWorld.metadata as { roles: Record<string, string> }).roles[
				IDS.user
			],
		).toBe("USER");
	});

	it.each([
		["peer ADMIN", IDS.peerAdmin, "USER"],
		["OWNER", IDS.owner, "USER"],
		["self", IDS.admin, "USER"],
		["OWNER grant", IDS.user, "OWNER"],
	] as const)("denies changing %s", async (_label, target, newRole) => {
		const { result, updateWorld } = await assign(target, newRole);

		expect(result).toMatchObject({
			success: false,
			values: { successCount: 0, failureCount: 1 },
		});
		expect(updateWorld).not.toHaveBeenCalled();
	});
});
