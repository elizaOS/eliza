import type { IAgentRuntime, Memory } from "./types";
import { describe, expect, it } from "vitest";
import {
	canModifyRole,
	getEntityRole,
	isAgentSelf,
	matchEntityToConnectorAdminWhitelist,
	normalizeRole,
} from "./roles.ts";

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
});
