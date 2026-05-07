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
		expect(defaultContextRegistry.has("social")).toBe(false);
		expect(defaultContextRegistry.has("system")).toBe(false);
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
