/**
 * Unit tests for the role and context gate filters (`filterByContextGate`,
 * `filterProvidersByContextGate` / `resolveProviderContextGate`,
 * `normalizeGateRole`). Deterministic in-line literal fixtures — no runtime,
 * model, or database.
 */
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../types/contexts";
import type { RoleGateRole } from "./context-gates";
import {
	filterByContextGate,
	filterProvidersByContextGate,
	normalizeGateRole,
	resolveProviderContextGate,
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

describe("filterProvidersByContextGate — full declared contextGate honored (#13203)", () => {
	// A world-style, gate-only provider: contextGate with anyOf and NO contexts.
	// filterByContextGate's {contexts, roleGate} reduction drops the anyOf terms,
	// so this provider used to lose its gate entirely on the planner path.
	const walletGated = {
		name: "WALLET_GATED_SIGNAL",
		contextGate: { anyOf: ["wallet"] as AgentContext[] },
	};

	it("selects a gate-only anyOf provider on its gate turn", () => {
		expect(
			filterProvidersByContextGate([walletGated], ["wallet"] as AgentContext[]),
		).toEqual([walletGated]);
	});

	it("excludes a gate-only anyOf provider on unrelated turns", () => {
		expect(
			filterProvidersByContextGate([walletGated], [
				"general",
			] as AgentContext[]),
		).toEqual([]);
		expect(filterProvidersByContextGate([walletGated], [])).toEqual([]);
	});

	it("honors allOf: requires every listed context to be active", () => {
		const both = {
			name: "WALLET_AND_CODE",
			contextGate: { allOf: ["wallet", "code"] as AgentContext[] },
		};
		expect(
			filterProvidersByContextGate([both], [
				"wallet",
				"code",
			] as AgentContext[]),
		).toEqual([both]);
		expect(
			filterProvidersByContextGate([both], ["wallet"] as AgentContext[]),
		).toEqual([]);
	});

	it("honors noneOf: an active denied context excludes the provider", () => {
		const notInCode = {
			name: "NOT_IN_CODE",
			contexts: ["general"] as AgentContext[],
			contextGate: {
				anyOf: ["general"] as AgentContext[],
				noneOf: ["code"] as AgentContext[],
			},
		};
		expect(
			filterProvidersByContextGate([notInCode], ["general"] as AgentContext[]),
		).toEqual([notInCode]);
		expect(
			filterProvidersByContextGate([notInCode], [
				"general",
				"code",
			] as AgentContext[]),
		).toEqual([]);
	});

	it("preserves the top-level roleGate under a gate-only contextGate (#12087 Item 14)", () => {
		const adminOnly = {
			name: "ADMIN_ONLY_SIGNAL",
			contextGate: { anyOf: ["admin"] as AgentContext[] },
			roleGate: { minRole: "ADMIN" as RoleGateRole },
		};
		const active = ["admin"] as AgentContext[];
		expect(filterProvidersByContextGate([adminOnly], active, ["USER"])).toEqual(
			[],
		);
		expect(
			filterProvidersByContextGate([adminOnly], active, ["ADMIN"]),
		).toEqual([adminOnly]);
	});

	it("resolves an undeclared provider through the catalog (AVAILABLE_AGENTS → code/automation, #13203)", () => {
		const availableAgents = { name: "AVAILABLE_AGENTS" };
		expect(
			filterProvidersByContextGate([availableAgents], [
				"code",
			] as AgentContext[]),
		).toEqual([availableAgents]);
		expect(
			filterProvidersByContextGate([availableAgents], [
				"general",
			] as AgentContext[]),
		).toEqual([]);
	});

	it("defaults an undeclared, uncataloged provider to the general context", () => {
		const undeclared = { name: "TOTALLY_UNDECLARED_SIGNAL" };
		expect(
			filterProvidersByContextGate([undeclared], ["general"] as AgentContext[]),
		).toEqual([undeclared]);
		expect(
			filterProvidersByContextGate([undeclared], ["wallet"] as AgentContext[]),
		).toEqual([]);
	});

	it("keeps declared-contexts providers on their declared routing (hot-path parity)", () => {
		const declared = {
			name: "DECLARED_CONTEXTS",
			contexts: ["documents"] as AgentContext[],
		};
		expect(resolveProviderContextGate(declared)).toEqual({
			contexts: ["documents"],
			roleGate: undefined,
		});
		expect(
			filterProvidersByContextGate([declared], ["documents"] as AgentContext[]),
		).toEqual([declared]);
		expect(
			filterProvidersByContextGate([declared], ["general"] as AgentContext[]),
		).toEqual([]);
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
