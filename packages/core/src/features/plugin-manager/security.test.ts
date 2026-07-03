import { describe, expect, it } from "vitest";
import type { RoleCheckResult, RoleName } from "../../roles.ts";
import type { IAgentRuntime, Memory } from "../../types/index.ts";
import {
	hasAdminAccess,
	hasOwnerAccess,
	type SecurityDeps,
} from "./security.ts";

/**
 * #12087 Item 18: hasOwnerAccess/hasAdminAccess are thin wrappers over roles.ts
 * hasRoleAccess. These exercise the injected-deps seam (which replaced the
 * copy-pasted role-resolution flow) and pin the owner/admin thresholds and the
 * agent-self / canonical-owner / no-context short-circuits.
 */
const AGENT = "00000000-0000-0000-0000-0000000000a1";
const SENDER = "00000000-0000-0000-0000-0000000000b1";

const runtime = { agentId: AGENT } as unknown as IAgentRuntime;
const message = {
	entityId: SENDER,
	roomId: "00000000-0000-0000-0000-0000000000c1",
	content: { text: "" },
} as unknown as Memory;

function roleResult(role: RoleName): RoleCheckResult {
	return {
		entityId: SENDER as RoleCheckResult["entityId"],
		role,
		isOwner: role === "OWNER",
		isAdmin: role === "OWNER" || role === "ADMIN",
		canManageRoles: role === "OWNER" || role === "ADMIN",
	};
}

// A sender who is never the canonical owner, so the role check is exercised.
function depsFor(role: RoleName): SecurityDeps {
	return {
		resolveCanonicalOwnerIdForMessage: async () => null,
		checkSenderRole: async () => roleResult(role),
	};
}

describe("plugin-manager security wrappers → hasRoleAccess (#12087 Item 18)", () => {
	it("hasOwnerAccess grants only OWNER", async () => {
		expect(await hasOwnerAccess(runtime, message, depsFor("OWNER"))).toBe(true);
		expect(await hasOwnerAccess(runtime, message, depsFor("ADMIN"))).toBe(
			false,
		);
		expect(await hasOwnerAccess(runtime, message, depsFor("USER"))).toBe(false);
	});

	it("hasAdminAccess grants ADMIN and OWNER, denies below", async () => {
		expect(await hasAdminAccess(runtime, message, depsFor("OWNER"))).toBe(true);
		expect(await hasAdminAccess(runtime, message, depsFor("ADMIN"))).toBe(true);
		expect(await hasAdminAccess(runtime, message, depsFor("USER"))).toBe(false);
		expect(await hasAdminAccess(runtime, message, depsFor("GUEST"))).toBe(
			false,
		);
	});

	it("short-circuits agent-self and canonical owner without a role lookup", async () => {
		let roleChecked = false;
		const spyDeps: SecurityDeps = {
			resolveCanonicalOwnerIdForMessage: async () => null,
			checkSenderRole: async () => {
				roleChecked = true;
				return null;
			},
		};
		const selfMsg = { ...message, entityId: AGENT } as unknown as Memory;
		expect(await hasOwnerAccess(runtime, selfMsg, spyDeps)).toBe(true);

		expect(
			await hasOwnerAccess(runtime, message, {
				resolveCanonicalOwnerIdForMessage: async () => SENDER,
				checkSenderRole: async () => {
					roleChecked = true;
					return null;
				},
			}),
		).toBe(true);

		expect(roleChecked).toBe(false);
	});

	it("allows through with no runtime/message context (auth handled elsewhere)", async () => {
		expect(await hasOwnerAccess(undefined, undefined)).toBe(true);
		expect(await hasAdminAccess(runtime, undefined)).toBe(true);
	});
});
