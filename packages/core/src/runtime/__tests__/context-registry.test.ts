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

	it("expands lifeops only as a migration alias", () => {
		expect(normalizeContextList(["lifeops"])).toEqual([
			"email",
			"calendar",
			"contacts",
			"tasks",
			"health",
			"screen_time",
			"subscriptions",
			"payments",
			"messaging",
			"social_posting",
			"automation",
			"connectors",
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

		expect(
			filterByContextGate(candidates, ["lifeops"], ["MEMBER"]).map(
				(candidate) => candidate.name,
			),
		).toEqual(["calendar"]);
		expect(
			filterByContextGate(candidates, ["admin"], ["OWNER"]).map(
				(candidate) => candidate.name,
			),
		).toEqual(["admin"]);
	});

	it("checks context and role gates", () => {
		expect(
			satisfiesContextGate(["calendar"], {
				anyOf: ["lifeops"],
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
