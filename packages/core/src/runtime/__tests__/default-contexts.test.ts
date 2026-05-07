import { describe, expect, it } from "vitest";
import { ContextRegistry } from "../context-registry";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../default-contexts";

describe("default-contexts", () => {
	it("has unique ids", () => {
		const ids = DEFAULT_CONTEXT_DEFINITIONS.map((definition) => definition.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("each definition has at minimum the required ContextDefinition fields", () => {
		for (const definition of DEFAULT_CONTEXT_DEFINITIONS) {
			expect(typeof definition.id).toBe("string");
			expect(definition.id.length).toBeGreaterThan(0);
			expect(typeof definition.label).toBe("string");
			expect(typeof definition.description).toBe("string");
			expect(definition.description?.length).toBeGreaterThan(0);
		}
	});

	it("registers cleanly into a fresh ContextRegistry and round-trips through list()", () => {
		const registry = new ContextRegistry([]);
		const { added, skipped } = registry.tryRegisterMany(
			DEFAULT_CONTEXT_DEFINITIONS,
		);
		expect(added.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
		expect(skipped).toEqual([]);

		const listed = registry.list();
		expect(listed.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
		for (const definition of DEFAULT_CONTEXT_DEFINITIONS) {
			expect(registry.has(definition.id)).toBe(true);
		}
	});

	it("tryRegisterMany is idempotent on duplicate ids", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);
		const { added, skipped } = registry.tryRegisterMany(
			DEFAULT_CONTEXT_DEFINITIONS,
		);
		expect(added).toEqual([]);
		expect(skipped.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
	});

	it("listAvailable filters out OWNER-only contexts for USER role", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);

		const userContexts = registry
			.listAvailable("USER")
			.map((definition) => definition.id);

		// `secrets`, `admin`, `agent_internal`, `health`, `terminal`, `screen_time`,
		// `subscriptions`, `payments`, and `wallet` are OWNER-only per PLAN.md §4.3.
		const ownerOnly = [
			"secrets",
			"admin",
			"agent_internal",
			"health",
			"terminal",
			"screen_time",
			"subscriptions",
			"payments",
			"wallet",
		];
		for (const id of ownerOnly) {
			expect(userContexts).not.toContain(id);
		}

		// `general`, `web`, `memory`, `knowledge`, and `media` are USER-or-below.
		expect(userContexts).toEqual(
			expect.arrayContaining(["general", "web", "memory", "knowledge", "media"]),
		);
	});

	it("listAvailable for OWNER includes every context", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);

		const ownerContexts = registry.listAvailable("OWNER");
		expect(ownerContexts.length).toBe(DEFAULT_CONTEXT_DEFINITIONS.length);
	});

	it("listAvailable for GUEST includes only ungated public contexts", () => {
		const registry = new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS);

		const guestContexts = registry
			.listAvailable("GUEST")
			.map((definition) => definition.id);
		// `general` is the canonical GUEST context.
		expect(guestContexts).toContain("general");
		// USER-gated contexts are excluded from GUEST.
		expect(guestContexts).not.toContain("memory");
		expect(guestContexts).not.toContain("knowledge");
	});
});
