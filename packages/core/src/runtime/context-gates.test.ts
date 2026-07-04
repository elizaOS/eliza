import { describe, expect, it } from "vitest";
import type { AgentContext } from "../types/contexts";
import type { RoleGateRole } from "./context-gates";
import { filterByContextGate, normalizeGateRole } from "./context-gates";

/**
 * Tests for the role-gate normalizer (#8801 / #9943). normalizeGateRole canon-
 * icalizes a role before a gate check; the USER->MEMBER alias and the case/trim
 * handling must be consistent or role gating silently diverges. It was untested.
 */
const norm = (r: string) => normalizeGateRole(r as RoleGateRole);

describe("filterByContextGate — top-level roleGate under an explicit contextGate (#12087 Item 14)", () => {
	// A provider/action that declares BOTH a top-level roleGate and an explicit
	// contextGate (context requirement only). The contextGate must not shadow the
	// declared role requirement.
	const item = {
		name: "ADMIN_ONLY",
		contextGate: { contexts: ["admin"] as AgentContext[] },
		roleGate: { minRole: "ADMIN" as RoleGateRole },
	};
	const active = ["admin"] as AgentContext[];

	it("drops the item for a USER even though the (context-only) contextGate passes", () => {
		expect(filterByContextGate([item], active, ["USER"])).toEqual([]);
	});

	it("keeps the item for an ADMIN in the active context", () => {
		expect(filterByContextGate([item], active, ["ADMIN"])).toEqual([item]);
	});
});

describe("normalizeGateRole", () => {
	it("aliases USER to MEMBER", () => {
		expect(norm("USER")).toBe("MEMBER");
		expect(norm("user")).toBe("MEMBER");
	});

	it("uppercases and trims", () => {
		expect(norm("  admin  ")).toBe("ADMIN");
		expect(norm("owner")).toBe("OWNER");
	});

	it("leaves an already-canonical role unchanged", () => {
		expect(norm("MEMBER")).toBe("MEMBER");
		expect(norm("OWNER")).toBe("OWNER");
	});
});
