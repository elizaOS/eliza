/**
 * Covers the context registry and gate helpers: id normalization, first-party
 * context registration, finance-alias expansion, context/role-gate candidate
 * filtering, and parent/subcontext cycle detection. Pure, no model.
 */
import { describe, expect, it } from "vitest";
import type { ContextDefinition } from "../../types/contexts";
import {
	type ContextGateCandidate,
	filterByContextGate,
	satisfiesContextGate,
	satisfiesRoleGate,
} from "../context-gates";
import {
	ContextRegistry,
	ContextRegistryError,
	defaultContextRegistry,
	FIRST_PARTY_CONTEXT_IDS,
	normalizeContextId,
	normalizeContextList,
} from "../context-registry";

describe("context registry", () => {
	it("normalizes context ids", () => {
		expect(normalizeContextId(" Screen-Time ")).toBe("screen_time");
		expect(normalizeContextId("SOCIAL POSTING")).toBe("social_posting");
	});

	it("registers first-party contexts", () => {
		for (const context of FIRST_PARTY_CONTEXT_IDS) {
			expect(defaultContextRegistry.has(context)).toBe(true);
		}
		expect(defaultContextRegistry.has("lifeops")).toBe(false);
	});

	it("expands the remaining finance aliases", () => {
		expect(normalizeContextList(["money"])).toEqual([
			"finance",
			"wallet",
			"crypto",
		]);
		expect(normalizeContextList(["defi"])).toEqual([
			"crypto",
			"wallet",
			"finance",
		]);
	});

	it("filters candidates by normalized gates", () => {
		const candidates = [
			{ name: "calendar", contexts: ["calendar"] },
			{ name: "wallet", contexts: ["wallet"] },
			{
				name: "admin",
				contextGate: { anyOf: ["admin"], roleGate: { minRole: "ADMIN" } },
			},
		] satisfies Array<ContextGateCandidate & { name: string }>;

		// `money` expands to finance/wallet/crypto, so only the wallet
		// candidate matches.
		expect(
			filterByContextGate(candidates, ["money"], ["MEMBER"]).map(
				(candidate) => candidate.name,
			),
		).toEqual(["wallet"]);
		expect(
			filterByContextGate(candidates, ["admin"], ["OWNER"]).map(
				(candidate) => candidate.name,
			),
		).toEqual(["admin"]);
	});

	it("checks context and role gates", () => {
		// `money` alias expands through wallet, so candidates declaring
		// `wallet` satisfy a `{ anyOf: ["money"] }` gate.
		expect(
			satisfiesContextGate(["wallet"], {
				anyOf: ["money"],
			}),
		).toBe(true);
		expect(satisfiesRoleGate(["OWNER"], { minRole: "ADMIN" })).toBe(true);
		expect(satisfiesRoleGate(["MEMBER"], { minRole: "ADMIN" })).toBe(false);
	});

	it("unregisters a leaf context and reflects removal in has/get", () => {
		const registry = new ContextRegistry([
			{ id: "alpha", subcontexts: ["beta"] },
			{ id: "beta" },
			{ id: "gamma" },
		]);

		expect(registry.has("gamma")).toBe(true);
		expect(registry.unregister("gamma")).toBe(true);
		expect(registry.has("gamma")).toBe(false);
		expect(registry.get("gamma")).toBeUndefined();
		// Unrelated definitions survive.
		expect(registry.has("alpha")).toBe(true);
		expect(registry.has("beta")).toBe(true);
	});

	it("normalizes ids before removal", () => {
		const registry = new ContextRegistry([{ id: "screen_time" }]);
		expect(registry.unregister(" Screen-Time ")).toBe(true);
		expect(registry.has("screen_time")).toBe(false);
	});

	it("returns false when unregistering an unknown id", () => {
		const registry = new ContextRegistry([{ id: "alpha" }]);
		expect(registry.unregister("nope")).toBe(false);
		expect(registry.has("alpha")).toBe(true);
	});

	it("partitions unregisterMany into removed and missing", () => {
		const registry = new ContextRegistry([{ id: "alpha" }, { id: "beta" }]);

		const result = registry.unregisterMany(["alpha", "absent", "beta"]);
		expect(result.removed).toEqual(["alpha", "beta"]);
		expect(result.missing).toEqual(["absent"]);
		expect(registry.has("alpha")).toBe(false);
		expect(registry.has("beta")).toBe(false);
	});

	it("throws and leaves state intact when removal would orphan an edge", () => {
		const registry = new ContextRegistry([
			{ id: "parent_ctx", subcontexts: ["child_ctx"] },
			{ id: "child_ctx" },
		]);

		expect(() => registry.unregister("child_ctx")).toThrow(
			ContextRegistryError,
		);
		// The failed validation must not mutate the registry.
		expect(registry.has("child_ctx")).toBe(true);
		expect(registry.has("parent_ctx")).toBe(true);
		expect(registry.get("parent_ctx")?.subcontexts).toEqual(["child_ctx"]);
	});

	it("throws when a surviving parent edge would dangle", () => {
		const registry = new ContextRegistry([
			{ id: "root_ctx" },
			{ id: "leaf_ctx", parent: "root_ctx" },
		]);

		expect(() => registry.unregister("root_ctx")).toThrow(ContextRegistryError);
		expect(registry.has("root_ctx")).toBe(true);
		expect(registry.has("leaf_ctx")).toBe(true);
	});

	it("removes a context together with its referencing definition", () => {
		const registry = new ContextRegistry([
			{ id: "parent_ctx", subcontexts: ["child_ctx"] },
			{ id: "child_ctx" },
			{ id: "other_ctx" },
		]);

		const result = registry.unregisterMany(["parent_ctx", "child_ctx"]);
		expect(result.removed).toEqual(["parent_ctx", "child_ctx"]);
		expect(result.missing).toEqual([]);
		expect(registry.has("parent_ctx")).toBe(false);
		expect(registry.has("child_ctx")).toBe(false);
		expect(registry.has("other_ctx")).toBe(true);
	});

	it("reports only missing ids without mutating when nothing is removed", () => {
		const registry = new ContextRegistry([{ id: "alpha" }]);
		const result = registry.unregisterMany(["x", "y"]);
		expect(result.removed).toEqual([]);
		expect(result.missing).toEqual(["x", "y"]);
		expect(registry.has("alpha")).toBe(true);
	});

	it("detects parent and subcontext cycles", () => {
		const definitions: ContextDefinition[] = [
			{ id: "alpha", subcontexts: ["beta"] },
			{ id: "beta", subcontexts: ["alpha"] },
		];

		expect(() => new ContextRegistry(definitions)).toThrow(
			ContextRegistryError,
		);
	});
});
