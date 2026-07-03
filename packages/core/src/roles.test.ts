import { describe, expect, it } from "vitest";
import {
	CANONICAL_ROLE_RANK,
	canModifyRole,
	getEntityRole,
	hasRoleAccess,
	isAgentSelf,
	matchEntityToConnectorAdminWhitelist,
	normalizeRole,
	ROLE_RANK,
	recordOwnerGrant,
} from "./roles.ts";
import {
	roleRank as gateRoleRank,
	satisfiesRoleGate,
} from "./runtime/context-gates.ts";
import type { IAgentRuntime, Memory } from "./types";

/**
 * Role + permission helpers. canModifyRole is the privilege-escalation gate:
 * OWNER may change anyone, ADMIN may only manage strictly-lower ranks and may
 * never grant OWNER, and USER/GUEST may change no one. normalizeRole must fold
 * unknown input to GUEST (never silently grant a higher role), and the
 * connector-admin whitelist matches an entity only on its stable platform id.
 */

describe("normalizeRole", () => {
	it("recognizes the three named roles, else GUEST", () => {
		expect(normalizeRole("owner")).toBe("OWNER");
		expect(normalizeRole("Admin")).toBe("ADMIN");
		expect(normalizeRole("USER")).toBe("USER");
		expect(normalizeRole("superuser")).toBe("GUEST");
		expect(normalizeRole(null)).toBe("GUEST");
	});
});

describe("getEntityRole", () => {
	it("reads + normalizes a role from world metadata, GUEST when absent", () => {
		const meta = { roles: { e1: "ADMIN", e2: "nonsense" } } as never;
		expect(getEntityRole(meta, "e1")).toBe("ADMIN");
		expect(getEntityRole(meta, "e2")).toBe("GUEST");
		expect(getEntityRole(undefined, "e1")).toBe("GUEST");
	});
});

describe("canModifyRole — privilege escalation gate", () => {
	it("OWNER can change anyone (but not a no-op)", () => {
		expect(canModifyRole("OWNER", "USER", "ADMIN")).toBe(true);
		expect(canModifyRole("OWNER", "ADMIN", "USER")).toBe(true);
		expect(canModifyRole("OWNER", "USER", "USER")).toBe(false); // no-op
	});

	it("ADMIN may only manage strictly-lower ranks and never grant OWNER", () => {
		expect(canModifyRole("ADMIN", "USER", "ADMIN")).toBe(true);
		expect(canModifyRole("ADMIN", "GUEST", "USER")).toBe(true);
		expect(canModifyRole("ADMIN", "ADMIN", "USER")).toBe(false); // same rank
		expect(canModifyRole("ADMIN", "USER", "OWNER")).toBe(false); // can't grant OWNER
	});

	it("USER and GUEST can change no one", () => {
		expect(canModifyRole("USER", "GUEST", "USER")).toBe(false);
		expect(canModifyRole("GUEST", "GUEST", "USER")).toBe(false);
	});
});

describe("isAgentSelf", () => {
	it("is true only when the message sender is the agent itself", () => {
		const runtime = { agentId: "agent-1" } as IAgentRuntime;
		expect(isAgentSelf(runtime, { entityId: "agent-1" } as Memory)).toBe(true);
		expect(isAgentSelf(runtime, { entityId: "someone-else" } as Memory)).toBe(
			false,
		);
		expect(isAgentSelf(undefined, { entityId: "agent-1" } as Memory)).toBe(
			false,
		);
	});
});

describe("hasRoleAccess — fail-closed on unresolved role", () => {
	// A message with a real entity/room but no resolvable world (deleted or
	// inaccessible world, or a source that yields no world id) makes
	// checkSenderRole return null. That path used to `return true` (fail-OPEN) —
	// a guest whose world resolution failed cleared the OWNER gate and reached
	// owner-gated capabilities (e.g. SHELL). It must fail closed to USER rank
	// (matching the pre-handler default), denying ADMIN/OWNER while still
	// allowing basic USER actions.
	const makeRuntime = (settings: Record<string, string> = {}) =>
		({
			agentId: "agent-1",
			getRoom: async () => null,
			getWorld: async () => null,
			getEntityById: async () => null,
			getComponents: async () => [],
			getMemories: async () => [],
			getRelationships: async () => [],
			getSetting: (key: string) => settings[key],
			character: {},
		}) as unknown as IAgentRuntime;
	const guestMessage = {
		entityId: "guest-entity-1",
		roomId: "room-1",
		content: { text: "run df -h on the server", source: "test" },
	} as unknown as Memory;

	it("denies OWNER and ADMIN when the sender role cannot be resolved", async () => {
		const runtime = makeRuntime();
		expect(await hasRoleAccess(runtime, guestMessage, "OWNER")).toBe(false);
		expect(await hasRoleAccess(runtime, guestMessage, "ADMIN")).toBe(false);
	});

	it("still allows USER (matches the pre-handler ['USER'] default) and GUEST", async () => {
		const runtime = makeRuntime();
		expect(await hasRoleAccess(runtime, guestMessage, "USER")).toBe(true);
		expect(await hasRoleAccess(runtime, guestMessage, "GUEST")).toBe(true);
	});

	it("still allows the canonical owner through the OWNER gate", async () => {
		const runtime = makeRuntime({ ELIZA_ADMIN_ENTITY_ID: "owner-entity-1" });
		const ownerMessage = {
			entityId: "owner-entity-1",
			roomId: "room-1",
			content: { text: "run df -h on the server", source: "test" },
		} as unknown as Memory;
		expect(await hasRoleAccess(runtime, ownerMessage, "OWNER")).toBe(true);
		expect(await hasRoleAccess(runtime, ownerMessage, "ADMIN")).toBe(true);
	});

	it("still allows the agent itself", async () => {
		const runtime = makeRuntime();
		const selfMessage = {
			entityId: "agent-1",
			roomId: "room-1",
			content: { text: "internal", source: "test" },
		} as unknown as Memory;
		expect(await hasRoleAccess(runtime, selfMessage, "OWNER")).toBe(true);
	});
});

describe("matchEntityToConnectorAdminWhitelist", () => {
	it("matches an entity's stable platform id against the whitelist", () => {
		const whitelist = { discord: ["user-123"] };
		const match = matchEntityToConnectorAdminWhitelist(
			{ discord: { userId: "user-123" } },
			whitelist,
		);
		expect(match).toMatchObject({
			connector: "discord",
			matchedValue: "user-123",
		});
		expect(
			matchEntityToConnectorAdminWhitelist(
				{ discord: { userId: "other" } },
				whitelist,
			),
		).toBeNull();
		expect(matchEntityToConnectorAdminWhitelist(null, whitelist)).toBeNull();
	});

	it("does not match mutable username fields against the whitelist", () => {
		const whitelist = { discord: ["alice"] };

		expect(
			matchEntityToConnectorAdminWhitelist(
				{ discord: { username: "alice", userName: "alice" } },
				whitelist,
			),
		).toBeNull();
	});
});

describe("canonical role rank (#9948)", () => {
	it("orders all tiers NONE < GUEST < USER < ADMIN < OWNER", () => {
		expect(CANONICAL_ROLE_RANK.NONE).toBeLessThan(CANONICAL_ROLE_RANK.GUEST);
		expect(CANONICAL_ROLE_RANK.GUEST).toBeLessThan(CANONICAL_ROLE_RANK.USER);
		expect(CANONICAL_ROLE_RANK.USER).toBeLessThan(CANONICAL_ROLE_RANK.ADMIN);
		expect(CANONICAL_ROLE_RANK.ADMIN).toBeLessThan(CANONICAL_ROLE_RANK.OWNER);
	});

	it("treats USER and MEMBER as the same tier", () => {
		expect(CANONICAL_ROLE_RANK.MEMBER).toBe(CANONICAL_ROLE_RANK.USER);
	});

	it("derives the RoleName-keyed ROLE_RANK from the canonical table", () => {
		expect(ROLE_RANK.GUEST).toBe(CANONICAL_ROLE_RANK.GUEST);
		expect(ROLE_RANK.USER).toBe(CANONICAL_ROLE_RANK.USER);
		expect(ROLE_RANK.ADMIN).toBe(CANONICAL_ROLE_RANK.ADMIN);
		expect(ROLE_RANK.OWNER).toBe(CANONICAL_ROLE_RANK.OWNER);
	});

	it("makes context-gates ranking share the one source of truth", () => {
		// Previously context-gates kept its own literal that could drift.
		expect(gateRoleRank("OWNER")).toBe(CANONICAL_ROLE_RANK.OWNER);
		expect(gateRoleRank("ADMIN")).toBe(CANONICAL_ROLE_RANK.ADMIN);
		expect(gateRoleRank("USER")).toBe(CANONICAL_ROLE_RANK.USER);
		expect(gateRoleRank("MEMBER")).toBe(CANONICAL_ROLE_RANK.USER);
		expect(gateRoleRank("GUEST")).toBe(CANONICAL_ROLE_RANK.GUEST);
		expect(gateRoleRank("NONE")).toBe(CANONICAL_ROLE_RANK.NONE);
	});

	it("gates a minRole:OWNER context to OWNER only", () => {
		expect(satisfiesRoleGate(["OWNER"], { minRole: "OWNER" })).toBe(true);
		expect(satisfiesRoleGate(["ADMIN"], { minRole: "OWNER" })).toBe(false);
		expect(satisfiesRoleGate(["USER"], { minRole: "ADMIN" })).toBe(false);
		expect(satisfiesRoleGate(["MEMBER"], { minRole: "USER" })).toBe(true);
	});
});

describe("role gate rejects unknown tiers (#9948)", () => {
	it("ranks an unknown role as 0 (below GUEST) so a stray value can never pass a gate", () => {
		// The RoleGateRole type no longer has a `(string & {})` escape, but the
		// runtime must still fail closed if an unknown value reaches roleRank.
		expect(gateRoleRank("SUPERUSER" as never)).toBe(0);
		expect(
			satisfiesRoleGate(["SUPERUSER" as never], { minRole: "GUEST" }),
		).toBe(false);
		expect(satisfiesRoleGate(["OWNER"], { minRole: "GUEST" })).toBe(true);
	});
});

describe("recordOwnerGrant (#9948 explicit auditable owner grant)", () => {
	it("records OWNER role AND the 'owner' grant source", () => {
		const metadata: {
			roles?: Record<string, string>;
			roleSources?: Record<string, string>;
		} = {};
		const changed = recordOwnerGrant(metadata as never, "owner-1");
		expect(changed).toBe(true);
		expect(metadata.roles?.["owner-1"]).toBe("OWNER");
		// The audit trail — what made this entity OWNER — is now queryable.
		expect(metadata.roleSources?.["owner-1"]).toBe("owner");
	});

	it("is idempotent (no change on a second call)", () => {
		const metadata: {
			roles?: Record<string, string>;
			roleSources?: Record<string, string>;
		} = {};
		recordOwnerGrant(metadata as never, "owner-1");
		expect(recordOwnerGrant(metadata as never, "owner-1")).toBe(false);
	});

	it("upgrades a bare roles entry that lacks a recorded source", () => {
		// The previous emergent path wrote roles[id]="OWNER" with NO source.
		const metadata = { roles: { "owner-1": "OWNER" } } as never;
		expect(recordOwnerGrant(metadata, "owner-1")).toBe(true);
		expect(
			(metadata as { roleSources?: Record<string, string> }).roleSources?.[
				"owner-1"
			],
		).toBe("owner");
	});
});
