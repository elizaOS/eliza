import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, UUID } from "../../../types/index.ts";

// Item 8 test stubs resolveEntityRole so getEntityRoles can be checked without
// standing up resolveEntityRole's full runtime dependency tree; the real
// CANONICAL_ROLE_RANK is preserved for the Item 5 roleHasPermission tests.
const { resolveEntityRoleMock } = vi.hoisted(() => ({
	resolveEntityRoleMock: vi.fn(),
}));
vi.mock("../../../roles.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../roles.ts")>();
	return { ...actual, resolveEntityRole: resolveEntityRoleMock };
});

import { ContextualPermissionSystem } from "./ContextualPermissionSystem.ts";

type RolePermProbe = {
	roleHasPermission: (
		role: string,
		action: string,
		resource: string,
	) => boolean;
	runtime: IAgentRuntime;
	getEntityRoles: (
		entityId: UUID,
		context: { worldId?: UUID },
	) => Promise<string[]>;
};

function probe(): RolePermProbe {
	return new ContextualPermissionSystem() as unknown as RolePermProbe;
}

/**
 * #12087 Item 5: role→action grants must accumulate by canonical rank. The prior
 * per-role map had no GUEST/USER/MEMBER row (those tiers got FEWER grants than
 * the unauthenticated NONE floor) and an ADMIN row missing the base grants (an
 * admin could not send_message).
 */
describe("ContextualPermissionSystem roleHasPermission (#12087 Item 5)", () => {
	const p = probe();
	const can = (role: string, action: string) =>
		p.roleHasPermission(role, action, "resource");

	it("grants every tier at NONE and above the base permissions", () => {
		for (const role of ["NONE", "GUEST", "MEMBER", "USER", "ADMIN", "OWNER"]) {
			expect(can(role, "send_message")).toBe(true);
			expect(can(role, "view_content")).toBe(true);
		}
	});

	it("gives MEMBER and GUEST at least the NONE grants (never fewer)", () => {
		// The exact regression: these used to return false (no row).
		expect(can("MEMBER", "request_elevation")).toBe(true);
		expect(can("GUEST", "request_elevation")).toBe(true);
		// ...but not admin-tier grants.
		expect(can("MEMBER", "manage_roles")).toBe(false);
		expect(can("GUEST", "ban_user")).toBe(false);
	});

	it("gives ADMIN the base grants plus the admin grants", () => {
		expect(can("ADMIN", "send_message")).toBe(true); // regression: was false
		expect(can("ADMIN", "manage_roles")).toBe(true);
		expect(can("ADMIN", "ban_user")).toBe(true);
		expect(can("ADMIN", "some_unknown_capability")).toBe(false);
	});

	it("gives OWNER everything", () => {
		expect(can("OWNER", "manage_roles")).toBe(true);
		expect(can("OWNER", "some_unknown_capability")).toBe(true);
	});

	it("treats an unrecognized role as the NONE floor, not a super-user", () => {
		expect(can("bogus", "send_message")).toBe(true);
		expect(can("bogus", "manage_roles")).toBe(false);
	});
});

/**
 * #12087 Item 8: getEntityRoles received an ALREADY-hashed world id. The prior
 * getUserServerRole re-hashed it as a serverId, found no world, and returned
 * NONE for every server-room member. It must resolve the world by that id
 * directly (via resolveEntityRole).
 */
describe("ContextualPermissionSystem getEntityRoles (#12087 Item 8)", () => {
	const WORLD_ID = "00000000-0000-0000-0000-000000000f01" as UUID;
	const ENTITY = "00000000-0000-0000-0000-000000000e02" as UUID;

	beforeEach(() => {
		resolveEntityRoleMock.mockReset();
	});

	it("resolves the role by the world id as-is (no re-hash) and returns it", async () => {
		resolveEntityRoleMock.mockResolvedValue("ADMIN");
		const getWorld = vi.fn(async () => ({
			id: WORLD_ID,
			metadata: { roles: { [ENTITY]: "ADMIN" } },
		}));
		const p = probe();
		p.runtime = { getWorld } as unknown as IAgentRuntime;

		const roles = await p.getEntityRoles(ENTITY, { worldId: WORLD_ID });

		expect(getWorld).toHaveBeenCalledWith(WORLD_ID);
		expect(roles).toEqual(["ADMIN"]);
	});

	it("returns no roles when there is no world context (DM)", async () => {
		const p = probe();
		p.runtime = { getWorld: vi.fn() } as unknown as IAgentRuntime;
		expect(await p.getEntityRoles(ENTITY, {})).toEqual([]);
	});
});
