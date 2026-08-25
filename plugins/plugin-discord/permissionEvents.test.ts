import { describe, expect, it, vi } from "vitest";
import {
	diffMemberRoles,
	diffOverwrites,
	diffRolePermissions,
	ELEVATED_PERMISSIONS,
	fetchAuditEntry,
	hasElevatedPermissions,
	isElevatedRole,
} from "./permissionEvents";

/** Minimal PermissionOverwrites-shaped stub. */
const overwrite = (allow: string[], deny: string[]) => ({
	allow: { toArray: () => allow },
	deny: { toArray: () => deny },
});

/** Minimal Role-shaped stub. */
const role = (perms: string[]) => ({
	permissions: {
		has: (p: string) => perms.includes(p),
		toArray: () => perms,
	},
});

/** Minimal Collection-like stub for roles.cache (discord.js Collection). */
class RoleCache extends Map {
	filter(predicate: (value: { id: string }) => boolean) {
		const out = new RoleCache();
		for (const [key, value] of this) {
			if (predicate(value)) out.set(key, value);
		}
		return out;
	}
}

/** Minimal GuildMember-shaped stub keyed by role id. */
const member = (roleIds: string[]) => ({
	roles: {
		cache: new RoleCache(roleIds.map((id) => [id, { id }])),
	},
});

const auditEntries = (
	entries: Array<{
		id?: string;
		createdAt?: number;
		executor?: { id: string; tag: string };
		reason?: string;
	}>,
) => ({
	entries: {
		values: () =>
			entries.map((e) => ({
				target: e.id !== undefined ? { id: e.id } : undefined,
				createdTimestamp: e.createdAt ?? Date.now(),
				executor: e.executor,
				reason: e.reason,
			})),
	},
});

describe("ELEVATED_PERMISSIONS", () => {
	it("covers the moderation/admin permission set", () => {
		for (const p of [
			"Administrator",
			"ManageGuild",
			"ManageRoles",
			"KickMembers",
			"BanMembers",
			"ManageMessages",
			"ManageWebhooks",
		]) {
			expect(ELEVATED_PERMISSIONS).toContain(p);
		}
	});

	it("excludes benign channel/view permissions", () => {
		for (const p of [
			"ViewChannel",
			"SendMessages",
			"AddReactions",
			"Connect",
		]) {
			expect(ELEVATED_PERMISSIONS).not.toContain(p);
		}
	});
});

describe("isElevatedRole", () => {
	it("flags a role holding any elevated permission", () => {
		expect(isElevatedRole(role(["BanMembers"]) as never)).toBe(true);
		expect(isElevatedRole(role(["Administrator"]) as never)).toBe(true);
	});

	it("does not flag a role with only benign permissions", () => {
		expect(isElevatedRole(role(["ViewChannel", "SendMessages"]) as never)).toBe(
			false,
		);
		expect(isElevatedRole(role([]) as never)).toBe(false);
	});
});

describe("hasElevatedPermissions", () => {
	it("returns true when any permission is elevated", () => {
		expect(hasElevatedPermissions(["ViewChannel", "KickMembers"])).toBe(true);
		expect(hasElevatedPermissions(["Administrator"])).toBe(true);
	});

	it("returns false for benign or empty permission lists", () => {
		expect(hasElevatedPermissions(["ViewChannel", "SendMessages"])).toBe(false);
		expect(hasElevatedPermissions([])).toBe(false);
	});

	it("classifies every entry of ELEVATED_PERMISSIONS as elevated", () => {
		for (const p of ELEVATED_PERMISSIONS) {
			expect(hasElevatedPermissions([p])).toBe(true);
		}
	});
});

describe("diffOverwrites", () => {
	it("treats two absent overwrites as a no-op update", () => {
		expect(diffOverwrites(null, null)).toEqual({
			changes: [],
			action: "UPDATE",
		});
		expect(diffOverwrites(undefined, undefined)).toEqual({
			changes: [],
			action: "UPDATE",
		});
	});

	it("classifies a newly created overwrite as CREATE with NEUTRAL->ALLOW/DENY", () => {
		const ow = overwrite(["KickMembers"], ["ViewChannel"]);
		const { changes, action } = diffOverwrites(null, ow as never);
		expect(action).toBe("CREATE");
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "NEUTRAL",
			newState: "ALLOW",
		});
		expect(changes).toContainEqual({
			permission: "ViewChannel",
			oldState: "NEUTRAL",
			newState: "DENY",
		});
	});

	it("classifies a removed overwrite as DELETE with ALLOW/DENY->NEUTRAL", () => {
		const ow = overwrite(["KickMembers"], ["ViewChannel"]);
		const { changes, action } = diffOverwrites(ow as never, null);
		expect(action).toBe("DELETE");
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "ALLOW",
			newState: "NEUTRAL",
		});
		expect(changes).toContainEqual({
			permission: "ViewChannel",
			oldState: "DENY",
			newState: "NEUTRAL",
		});
	});

	it("reports permission additions and removals on UPDATE", () => {
		const oldOw = overwrite(["KickMembers"], ["ViewChannel"]);
		const newOw = overwrite(["BanMembers"], []);
		const { changes, action } = diffOverwrites(oldOw as never, newOw as never);
		expect(action).toBe("UPDATE");
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "ALLOW",
			newState: "NEUTRAL",
		});
		expect(changes).toContainEqual({
			permission: "ViewChannel",
			oldState: "DENY",
			newState: "NEUTRAL",
		});
		expect(changes).toContainEqual({
			permission: "BanMembers",
			oldState: "NEUTRAL",
			newState: "ALLOW",
		});
	});

	it("reports ALLOW -> DENY transitions on UPDATE", () => {
		const oldOw = overwrite(["KickMembers"], []);
		const newOw = overwrite([], ["KickMembers"]);
		const { changes } = diffOverwrites(oldOw as never, newOw as never);
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "ALLOW",
			newState: "DENY",
		});
	});

	it("reports an escalation to ALLOW when an explicit deny is lifted (deny precedence)", () => {
		// Discord overwrite semantics: within one entry an explicit DENY beats ALLOW,
		// so {allow:[K], deny:[K]} is effectively denied. Dropping the deny while
		// keeping the allow grants the permission — the audit diff must surface the
		// DENY -> ALLOW change instead of treating both states as ALLOW.
		const oldOw = overwrite(["KickMembers"], ["KickMembers"]);
		const newOw = overwrite(["KickMembers"], []);
		const { changes } = diffOverwrites(oldOw as never, newOw as never);
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "DENY",
			newState: "ALLOW",
		});
	});

	it("reports a permission dropping out of both allow and deny", () => {
		const oldOw = overwrite(["KickMembers"], ["KickMembers"]);
		const newOw = overwrite([], []);
		const { changes } = diffOverwrites(oldOw as never, newOw as never);
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "DENY",
			newState: "NEUTRAL",
		});
	});
});

describe("diffRolePermissions", () => {
	it("reports added and removed role permissions", () => {
		const changes = diffRolePermissions(
			role(["KickMembers", "ViewChannel"]) as never,
			role(["ViewChannel", "BanMembers"]) as never,
		);
		expect(changes).toContainEqual({
			permission: "BanMembers",
			oldState: "NEUTRAL",
			newState: "ALLOW",
		});
		expect(changes).toContainEqual({
			permission: "KickMembers",
			oldState: "ALLOW",
			newState: "NEUTRAL",
		});
	});

	it("reports no changes for identical permission sets", () => {
		expect(
			diffRolePermissions(
				role(["KickMembers"]) as never,
				role(["KickMembers"]) as never,
			),
		).toEqual([]);
	});
});

describe("diffMemberRoles", () => {
	it("reports added and removed roles by id", () => {
		const { added, removed } = diffMemberRoles(
			member(["r1", "r2"]) as never,
			member(["r2", "r3"]) as never,
		);
		expect(added.map((r) => r.id)).toEqual(["r3"]);
		expect(removed.map((r) => r.id)).toEqual(["r1"]);
	});

	it("reports no role churn for identical memberships", () => {
		const { added, removed } = diffMemberRoles(
			member(["r1"]) as never,
			member(["r1"]) as never,
		);
		expect(added).toEqual([]);
		expect(removed).toEqual([]);
	});
});

describe("fetchAuditEntry", () => {
	const runtime = () => ({ logger: { debug: vi.fn() } });

	it("returns the matching entry when the target and recency window line up", async () => {
		const guild = {
			fetchAuditLogs: vi.fn().mockResolvedValue(
				auditEntries([
					{
						id: "user-1",
						createdAt: Date.now() - 1000,
						executor: { id: "mod-1", tag: "Mod#1" },
						reason: "spam",
					},
				]),
			),
		};
		const result = await fetchAuditEntry(
			guild as never,
			"MEMBER_KICK" as never,
			"user-1",
			runtime() as never,
		);
		expect(result).toEqual({
			executorId: "mod-1",
			executorTag: "Mod#1",
			reason: "spam",
		});
	});

	it("skips entries older than the 10s window", async () => {
		const guild = {
			fetchAuditLogs: vi
				.fn()
				.mockResolvedValue(
					auditEntries([{ id: "user-1", createdAt: Date.now() - 30_000 }]),
				),
		};
		expect(
			await fetchAuditEntry(
				guild as never,
				"MEMBER_KICK" as never,
				"user-1",
				runtime() as never,
			),
		).toBeNull();
	});

	it("skips entries for other targets", async () => {
		const guild = {
			fetchAuditLogs: vi
				.fn()
				.mockResolvedValue(
					auditEntries([{ id: "user-2", createdAt: Date.now() - 1000 }]),
				),
		};
		expect(
			await fetchAuditEntry(
				guild as never,
				"MEMBER_KICK" as never,
				"user-1",
				runtime() as never,
			),
		).toBeNull();
	});

	it("skips entries whose target has no id", async () => {
		const guild = {
			fetchAuditLogs: vi
				.fn()
				.mockResolvedValue(auditEntries([{ createdAt: Date.now() - 1000 }])),
		};
		expect(
			await fetchAuditEntry(
				guild as never,
				"MEMBER_KICK" as never,
				"user-1",
				runtime() as never,
			),
		).toBeNull();
	});

	it("degrades gracefully when the audit log fetch throws", async () => {
		const logger = { debug: vi.fn() };
		const guild = {
			fetchAuditLogs: vi.fn().mockRejectedValue(new Error("rate limited")),
		};
		const result = await fetchAuditEntry(
			guild as never,
			"MEMBER_KICK" as never,
			"user-1",
			{ logger } as never,
		);
		expect(result).toBeNull();
		expect(logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("rate limited"),
		);
	});

	it("falls back to unknown executor metadata", async () => {
		const guild = {
			fetchAuditLogs: vi
				.fn()
				.mockResolvedValue(
					auditEntries([{ id: "user-1", createdAt: Date.now() - 1000 }]),
				),
		};
		const result = await fetchAuditEntry(
			guild as never,
			"MEMBER_KICK" as never,
			"user-1",
			runtime() as never,
		);
		expect(result).toEqual({
			executorId: "unknown",
			executorTag: "Unknown",
			reason: undefined,
		});
	});
});
