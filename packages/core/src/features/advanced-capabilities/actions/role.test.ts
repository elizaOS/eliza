/**
 * Unit coverage for the ROLE action (`roleAction`, alias `updateRoleAction`)
 * and `looksLikeRoleIntent`: the planner validation gate, list rendering,
 * single and batch assignment/revocation through the real roles.ts
 * authorization stack (mutations observed via `runtime.updateWorld`), and
 * current-room target-name resolution including its confidence gate and
 * recency tie-break.
 *
 * Deliberately NOT pinned after the #26278 review: unknown explicit
 * operations currently fall through to the assign default, and recent room
 * activity alone can still rank a speaker who is absent from
 * `getEntitiesForRoom`. Both need a production fail-closed authorization
 * repair before they belong in tests, so this suite neither asserts nor
 * freezes those paths — every resolved target here comes from current room
 * membership. Harness is real module logic behind plain-object fakes of the
 * IAgentRuntime boundary; no module mocks.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { looksLikeRoleIntent, roleAction, updateRoleAction } from "./role.ts";

const AGENT_ID = "66666666-6666-4666-8666-666666666666";
const WORLD_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const SERVER_ID = "message-server-1";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const PAT_ID = "44444444-4444-4444-8444-444444444444";
const SAM_ID = "55555555-5555-4555-8555-555555555555";
const STRANGER_ID = "88888888-8888-4888-8888-888888888888";

interface HarnessOptions {
	requesterId?: string;
	roles?: Record<string, string>;
	roleSources?: Record<string, string>;
	ownershipOwnerId?: string;
	members?: Array<{ id: string; names: string[] }>;
	memories?: Array<{ entityId: string; createdAt: number }>;
	worldPresent?: boolean;
	worldIdOnRoom?: boolean;
	roomMessageServerId?: string | null;
}

function buildHarness(options: HarnessOptions = {}) {
	const {
		requesterId = OWNER_ID,
		roles = {},
		roleSources = {},
		ownershipOwnerId = OWNER_ID,
		members = [
			{ id: PAT_ID, names: ["Pat"] },
			{ id: SAM_ID, names: ["Sam"] },
		],
		memories = [],
		worldPresent = true,
		worldIdOnRoom = true,
		roomMessageServerId = SERVER_ID,
	} = options;

	const worldMetadata: Record<string, unknown> = {};
	if (Object.keys(roles).length > 0) worldMetadata.roles = { ...roles };
	if (Object.keys(roleSources).length > 0) {
		worldMetadata.roleSources = { ...roleSources };
	}
	if (ownershipOwnerId) {
		worldMetadata.ownership = { ownerId: ownershipOwnerId };
	}

	const world = { id: WORLD_ID, name: "test-world", metadata: worldMetadata };
	const persistedMetadata: Array<Record<string, unknown>> = [];

	const runtime = {
		agentId: AGENT_ID,
		getSetting: () => undefined,
		getRoom: vi.fn(async () =>
			worldIdOnRoom
				? {
						id: ROOM_ID,
						worldId: WORLD_ID,
						messageServerId: roomMessageServerId ?? undefined,
					}
				: { id: ROOM_ID, messageServerId: roomMessageServerId ?? undefined },
		),
		getWorld: vi.fn(async () => (worldPresent ? world : null)),
		updateWorld: vi.fn(
			async (updated: { metadata: Record<string, unknown> }) => {
				persistedMetadata.push(updated.metadata);
			},
		),
		getEntitiesForRoom: vi.fn(async () =>
			members.map((member) => ({
				id: member.id,
				names: member.names,
				metadata: {},
			})),
		),
		getEntityById: vi.fn(async (entityId: string) => {
			const member = members.find((entry) => entry.id === entityId);
			return member
				? { id: member.id, names: member.names, metadata: {} }
				: null;
		}),
		getMemoriesByRoomIds: vi.fn(async () =>
			memories.map((memory, index) => ({
				id: `memory-${index}`,
				entityId: memory.entityId,
				createdAt: memory.createdAt,
			})),
		),
	} as unknown as IAgentRuntime;

	const message = {
		id: MESSAGE_ID,
		roomId: ROOM_ID,
		entityId: requesterId,
		agentId: AGENT_ID,
		createdAt: 1000,
		content: { text: "manage roles", channelType: ChannelType.GROUP },
	} as unknown as Memory;

	const callback = vi.fn(async (_content: unknown) => undefined);

	const callHandler = (parameters: Record<string, unknown>) =>
		roleAction.handler(runtime, message, undefined, { parameters }, callback);

	return {
		runtime,
		message,
		callback,
		callHandler,
		persistedMetadata,
		updateWorld: runtime.updateWorld as ReturnType<typeof vi.fn>,
	};
}

describe("ROLE action validate gate", () => {
	it("rejects DM-channel messages before touching the room", async () => {
		const harness = buildHarness();
		const dmMessage = {
			...harness.message,
			content: { text: "make Pat admin", channelType: ChannelType.DM },
		} as Memory;
		const ok = await roleAction.validate(harness.runtime, dmMessage);
		expect(ok).toBe(false);
		expect(harness.runtime.getRoom).not.toHaveBeenCalled();
	});

	it("rejects group messages whose room has no message server", async () => {
		const harness = buildHarness({ roomMessageServerId: null });
		const ok = await roleAction.validate(harness.runtime, harness.message);
		expect(ok).toBe(false);
	});

	it("accepts group messages in a message-server room", async () => {
		const harness = buildHarness();
		const ok = await roleAction.validate(harness.runtime, harness.message);
		expect(ok).toBe(true);
	});

	it("accepts WORLD-channel messages", async () => {
		const harness = buildHarness();
		const worldMessage = {
			...harness.message,
			content: { text: "manage roles", channelType: ChannelType.WORLD },
		} as Memory;
		const ok = await roleAction.validate(harness.runtime, worldMessage);
		expect(ok).toBe(true);
	});

	it("uses the state-provided room instead of fetching", async () => {
		const harness = buildHarness({ roomMessageServerId: null });
		const state = {
			data: { room: { id: ROOM_ID, messageServerId: SERVER_ID } },
		} as unknown as State;
		const ok = await roleAction.validate(
			harness.runtime,
			harness.message,
			state,
		);
		expect(ok).toBe(true);
		expect(harness.runtime.getRoom).not.toHaveBeenCalled();
	});
});

describe("looksLikeRoleIntent", () => {
	it("matches English role-management requests", () => {
		expect(looksLikeRoleIntent("make Pat an admin")).toBe(true);
		expect(looksLikeRoleIntent("he is the boss around here")).toBe(true);
	});

	it("matches non-English locale terms", () => {
		expect(looksLikeRoleIntent("我想修改他的角色")).toBe(true);
	});

	it("ignores surrounding whitespace", () => {
		expect(looksLikeRoleIntent("   promote him   ")).toBe(true);
	});

	it("rejects unrelated text", () => {
		expect(looksLikeRoleIntent("please fix the printer")).toBe(false);
	});

	it("rejects blank input", () => {
		expect(looksLikeRoleIntent("")).toBe(false);
		expect(looksLikeRoleIntent("     ")).toBe(false);
	});
});

describe("ROLE list operation", () => {
	it("renders resolved display names with counts and roles", async () => {
		const harness = buildHarness({
			requesterId: PAT_ID,
			roles: { [PAT_ID]: "ADMIN", [SAM_ID]: "USER" },
		});
		const result = await harness.callHandler({ action: "list" });

		expect(result.success).toBe(true);
		expect(result.text).toBe(`Pat: ADMIN\nSam: USER`);
		expect(result.values).toEqual({ roleCount: 2 });
		expect(result.data?.roles).toEqual({
			[PAT_ID]: "ADMIN",
			[SAM_ID]: "USER",
		});
		expect(harness.callback).toHaveBeenCalledOnce();
		expect(harness.callback).toHaveBeenCalledWith({
			text: `Pat: ADMIN\nSam: USER`,
			actions: ["ROLE"],
		});
	});

	it("falls back to raw entity ids when names cannot be resolved", async () => {
		const harness = buildHarness({
			requesterId: PAT_ID,
			roles: { [STRANGER_ID]: "ADMIN" },
		});
		const result = await harness.callHandler({ action: "list" });
		expect(result.success).toBe(true);
		expect(result.text).toBe(`${STRANGER_ID}: ADMIN`);
		expect(result.values).toEqual({ roleCount: 1 });
	});

	it("reports an empty world without entries", async () => {
		const harness = buildHarness({ requesterId: PAT_ID });
		const result = await harness.callHandler({ action: "list" });
		expect(result.success).toBe(true);
		expect(result.text).toBe("No role assignments.");
		expect(result.values).toEqual({ roleCount: 0 });
	});

	it("fails closed when the room has no world context", async () => {
		const harness = buildHarness({ requesterId: PAT_ID, worldIdOnRoom: false });
		const result = await harness.callHandler({ action: "list" });
		expect(result.success).toBe(false);
		expect(result.error).toBe("WORLD_NOT_FOUND");
		expect(harness.callback).not.toHaveBeenCalled();
	});

	it("routes through the legacy subaction alias", async () => {
		const harness = buildHarness({
			requesterId: PAT_ID,
			roles: { [SAM_ID]: "USER" },
		});
		const result = await harness.callHandler({ subaction: "list" });
		expect(result.success).toBe(true);
		expect(result.values).toEqual({ roleCount: 1 });
	});
});

describe("ROLE assignment by current-room target name", () => {
	it("resolves an exact member match and persists a manual grant", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			target: "Pat",
			role: "admin",
		});

		expect(result.success).toBe(true);
		expect(result.text).toBe("Updated 1 role.");
		expect(result.data?.successCount).toBe(1);
		expect(result.data?.worldId).toBe(WORLD_ID);
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "ADMIN",
		});
		expect(harness.persistedMetadata[0]?.roleSources).toMatchObject({
			[PAT_ID]: "manual",
		});
		expect(harness.callback).toHaveBeenCalledWith({
			text: "Updated 1 role.",
			actions: ["ROLE"],
		});
	});

	it("treats an absent operation as the deliberate assign default", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			target: "Pat",
			role: "USER",
		});
		expect(result.success).toBe(true);
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "USER",
		});
	});

	it("derives the role from a natural label via the user alias", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			user: "Pat",
			label: "boss",
		});
		expect(result.success).toBe(true);
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "ADMIN",
		});
	});

	it("strips mention punctuation from target names", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			target: "@Pat!",
			role: "ADMIN",
		});
		expect(result.success).toBe(true);
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "ADMIN",
		});
	});

	it("rejects re-granting a member's implicit GUEST tier as a no-op", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			target: "@Pat!",
			role: "GUEST",
		});
		expect(result.success).toBe(false);
		expect(result.values).toEqual({ successCount: 0, failureCount: 1 });
		expect(harness.persistedMetadata).toHaveLength(0);
	});

	it("refuses pronoun targets outright", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			target: "him",
			role: "ADMIN",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("ROLE_ASSIGN_FAILED");
		expect(result.data?.errors).toEqual(["Could not determine target user."]);
		expect(harness.updateWorld).not.toHaveBeenCalled();
		expect(harness.callback).not.toHaveBeenCalled();
	});

	it("reports names that match nobody in the room", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			target: "Zed",
			role: "ADMIN",
		});
		expect(result.success).toBe(false);
		expect(result.data?.errors).toEqual([
			`Could not find user "Zed" in this room.`,
		]);
		expect(harness.updateWorld).not.toHaveBeenCalled();
	});

	it("refuses ambiguous duplicates of the same display name", async () => {
		const harness = buildHarness({
			members: [
				{ id: PAT_ID, names: ["Pat"] },
				{ id: SAM_ID, names: ["Pat"] },
			],
		});
		const result = await harness.callHandler({
			action: "assign",
			target: "Pat",
			role: "ADMIN",
		});
		expect(result.success).toBe(false);
		expect(result.data?.errors?.[0]).toContain(
			`Multiple possible matches for "Pat"`,
		);
		expect(harness.updateWorld).not.toHaveBeenCalled();
	});

	it("breaks duplicate-name ties with recent room activity", async () => {
		const harness = buildHarness({
			members: [
				{ id: PAT_ID, names: ["Pat"] },
				{ id: SAM_ID, names: ["Pat"] },
			],
			memories: [{ entityId: SAM_ID, createdAt: 500 }],
		});
		const result = await harness.callHandler({
			action: "assign",
			target: "Pat",
			role: "ADMIN",
		});
		expect(result.success).toBe(true);
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[SAM_ID]: "ADMIN",
		});
	});
});

describe("ROLE structured batch assignments", () => {
	it("applies batch grants including alias roles", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			assignments: [
				{ entityId: PAT_ID, newRole: "mod" },
				{ entityId: SAM_ID, newRole: "teammate" },
			],
		});
		expect(result.success).toBe(true);
		expect(result.text).toBe("Updated 2 roles.");
		expect(result.values).toEqual({ successCount: 2, failureCount: 0 });
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "ADMIN",
			[SAM_ID]: "USER",
		});
	});

	it("skips entries missing entityId while applying the rest", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			assignments: [
				{ entityId: PAT_ID, newRole: "ADMIN" },
				{ newRole: "ADMIN" },
			],
		});
		expect(result.success).toBe(true);
		expect(result.values).toEqual({ successCount: 1, failureCount: 0 });
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "ADMIN",
		});
	});

	it("rejects the whole request when every role is invalid", async () => {
		const harness = buildHarness();
		const result = await harness.callHandler({
			action: "assign",
			assignments: [{ entityId: PAT_ID, newRole: "wizard" }],
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("ROLE_ASSIGN_FAILED");
		expect(result.data?.errors).toEqual([`Invalid role for ${PAT_ID}`]);
		expect(harness.updateWorld).not.toHaveBeenCalled();
		expect(harness.callback).not.toHaveBeenCalled();
	});
});

describe("ROLE authorization during apply", () => {
	it("blocks non-owners before any mutation", async () => {
		const harness = buildHarness({
			requesterId: PAT_ID,
			roles: { [PAT_ID]: "USER" },
		});
		const result = await harness.callHandler({
			action: "assign",
			target: "Sam",
			role: "ADMIN",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("INSUFFICIENT_PERMISSIONS");
		expect(result.data?.requesterRole).toBe("USER");
		expect(harness.updateWorld).not.toHaveBeenCalled();
		expect(harness.callback).not.toHaveBeenCalled();
	});

	it("fails closed when the world record vanished mid-flight", async () => {
		const harness = buildHarness({ worldPresent: false });
		const result = await harness.callHandler({
			action: "assign",
			assignments: [{ entityId: SAM_ID, newRole: "ADMIN" }],
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("WORLD_NOT_FOUND");
		expect(harness.updateWorld).not.toHaveBeenCalled();
	});

	it("never lets anyone change the agent's own role", async () => {
		const harness = buildHarness({ ownershipOwnerId: OWNER_ID });
		const result = await harness.callHandler({
			action: "assign",
			assignments: [{ entityId: AGENT_ID, newRole: "USER" }],
		});
		expect(result.success).toBe(false);
		expect(result.text).toBe("Updated 0 roles; 1 failed.");
		expect(result.values).toEqual({ successCount: 0, failureCount: 1 });
		expect(harness.callback).toHaveBeenCalledOnce();
		expect(harness.updateWorld).not.toHaveBeenCalled();
	});

	it("reserves the OWNER tier for the canonical owner", async () => {
		const harness = buildHarness({ ownershipOwnerId: OWNER_ID });
		const result = await harness.callHandler({
			action: "assign",
			assignments: [{ entityId: PAT_ID, newRole: "OWNER" }],
		});
		expect(result.success).toBe(false);
		expect(result.values).toEqual({ successCount: 0, failureCount: 1 });
		expect(harness.persistedMetadata).toHaveLength(0);
	});

	it("protects the last owner from self-demotion", async () => {
		const harness = buildHarness({
			roles: { [OWNER_ID]: "OWNER" },
			roleSources: { [OWNER_ID]: "manual" },
		});
		const result = await harness.callHandler({
			action: "revoke",
			assignments: [{ entityId: OWNER_ID }],
		});
		expect(result.success).toBe(false);
		expect(result.values).toEqual({ successCount: 0, failureCount: 1 });
		expect(harness.updateWorld).not.toHaveBeenCalled();
	});

	it("lets the sole owner demote another member to GUEST", async () => {
		const harness = buildHarness({
			roles: { [OWNER_ID]: "OWNER", [PAT_ID]: "USER" },
			roleSources: { [OWNER_ID]: "manual" },
		});
		const result = await harness.callHandler({
			action: "revoke",
			assignments: [{ entityId: PAT_ID }],
		});
		expect(result.success).toBe(true);
		expect(result.text).toBe("Revoked 1 role.");
		expect(harness.persistedMetadata[0]?.roles).toMatchObject({
			[PAT_ID]: "GUEST",
		});
		expect(
			(harness.persistedMetadata[0]?.roleSources as Record<string, string>)?.[
				PAT_ID
			],
		).toBeUndefined();
	});

	it("rejects no-op grants through canModifyRole", async () => {
		const harness = buildHarness({
			roles: { [PAT_ID]: "ADMIN" },
			ownershipOwnerId: OWNER_ID,
		});
		const result = await harness.callHandler({
			action: "assign",
			assignments: [{ entityId: PAT_ID, newRole: "ADMIN" }],
		});
		expect(result.success).toBe(false);
		expect(result.values).toEqual({ successCount: 0, failureCount: 1 });
		expect(harness.persistedMetadata).toHaveLength(0);
	});
});

describe("backwards-compatible export", () => {
	it("aliases updateRoleAction to the same action object", () => {
		expect(updateRoleAction).toBe(roleAction);
		expect(roleAction.name).toBe("ROLE");
	});
});
