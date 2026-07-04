/**
 * Unit tests for the role and context gate filters (`filterByContextGate`,
 * `filterProvidersByContextGate`, `normalizeGateRole`). Deterministic in-line
 * literal fixtures — no runtime, model, or database.
 */
import { describe, expect, it } from "vitest";
import type { Provider } from "../types/components";
import type { AgentContext } from "../types/contexts";
import type { RoleGateRole } from "./context-gates";
import {
	filterByContextGate,
	filterProvidersByContextGate,
	normalizeGateRole,
} from "./context-gates";

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

describe("filterProvidersByContextGate — lean-by-default provider selection", () => {
	const get = async () => ({ text: "", values: {}, data: {} });
	const names = (result: Provider[]) => result.map((p) => p.name);

	// A third-party plugin provider that declares nothing — the flood class.
	const undeclared: Provider = { name: "SOME_PLUGIN_SIGNAL", get };
	// A provider that scopes itself via `contexts`.
	const walletDeclared: Provider = {
		name: "WALLET_SIGNAL",
		contexts: ["wallet"] as AgentContext[],
		get,
	};
	// A provider gated only via contextGate.anyOf (the world-provider shape),
	// which the generic candidate filter cannot carry.
	const anyOfGated: Provider = {
		name: "GENERAL_ONLY_SIGNAL",
		contextGate: { anyOf: ["general"] as AgentContext[] },
		get,
	};
	// A core-catalog name with no declaration on the object itself.
	const catalogMapped: Provider = { name: "walletBalance", get };

	it("includes an undeclared provider on an ordinary general turn", () => {
		expect(
			names(filterProvidersByContextGate([undeclared], ["general"])),
		).toEqual(["SOME_PLUGIN_SIGNAL"]);
	});

	it("excludes an undeclared provider from a narrow tool/planner context", () => {
		expect(filterProvidersByContextGate([undeclared], ["wallet"])).toEqual([]);
	});

	it("keeps a declared provider on its matching narrow turn and off general turns", () => {
		expect(
			names(filterProvidersByContextGate([walletDeclared], ["wallet"])),
		).toEqual(["WALLET_SIGNAL"]);
		expect(filterProvidersByContextGate([walletDeclared], ["general"])).toEqual(
			[],
		);
	});

	it("resolves catalog contexts for known undeclared names", () => {
		expect(
			names(filterProvidersByContextGate([catalogMapped], ["wallet"])),
		).toEqual(["walletBalance"]);
		expect(filterProvidersByContextGate([catalogMapped], ["general"])).toEqual(
			[],
		);
	});

	it("honors contextGate.anyOf, which filterByContextGate drops", () => {
		expect(
			names(filterProvidersByContextGate([anyOfGated], ["general"])),
		).toEqual(["GENERAL_ONLY_SIGNAL"]);
		expect(filterProvidersByContextGate([anyOfGated], ["wallet"])).toEqual([]);
		// The generic candidate filter loses anyOf and floods the narrow turn —
		// the provider-specific filter is the fix.
		expect(filterByContextGate([anyOfGated], ["wallet"])).toEqual([anyOfGated]);
	});

	it("keeps the top-level roleGate under an explicit contextGate (#12087 Item 14)", () => {
		const adminOnly: Provider = {
			name: "ADMIN_ONLY_SIGNAL",
			contextGate: { contexts: ["admin"] as AgentContext[] },
			roleGate: { minRole: "ADMIN" as RoleGateRole },
			get,
		};
		expect(filterProvidersByContextGate([adminOnly], ["admin"], ["USER"])).toEqual(
			[],
		);
		expect(
			names(filterProvidersByContextGate([adminOnly], ["admin"], ["ADMIN"])),
		).toEqual(["ADMIN_ONLY_SIGNAL"]);
	});

	it("applies the top-level roleGate to an undeclared provider", () => {
		const gatedUndeclared: Provider = {
			name: "OWNER_PLUGIN_SIGNAL",
			roleGate: { minRole: "OWNER" as RoleGateRole },
			get,
		};
		expect(
			filterProvidersByContextGate([gatedUndeclared], ["general"], ["USER"]),
		).toEqual([]);
		expect(
			names(
				filterProvidersByContextGate([gatedUndeclared], ["general"], ["OWNER"]),
			),
		).toEqual(["OWNER_PLUGIN_SIGNAL"]);
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
