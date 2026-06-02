import { describe, expect, it } from "vitest";
import { getCachedActionCatalog } from "../services/message";
import type { Action } from "../types/components";

// Minimal valid Action for catalog construction. The catalog is built from the
// action name/description/similes; validate/handler are unused by the builder.
function mkAction(name: string): Action {
	return {
		name,
		description: `Performs the ${name} operation for the user.`,
		similes: [],
		examples: [],
		validate: async () => true,
		handler: async () => {},
	} as unknown as Action;
}

function hasAction(
	catalog: ReturnType<typeof getCachedActionCatalog>,
	name: string,
): boolean {
	return catalog.parents.some((parent) => parent.name === name);
}

describe("action catalog cache (F2: memoization + self-invalidation)", () => {
	it("returns the same cached catalog for an unchanged action set", () => {
		const actions = [mkAction("ALPHA_ACT"), mkAction("BETA_ACT")];
		const first = getCachedActionCatalog(actions);
		const second = getCachedActionCatalog(actions);
		// Same instance => the second call was a cache hit (no rebuild).
		expect(second).toBe(first);
		expect(hasAction(first, "ALPHA_ACT")).toBe(true);
		expect(hasAction(first, "BETA_ACT")).toBe(true);
	});

	it("invalidates when a new action is registered (e.g. a plugin/view action)", () => {
		const base = [mkAction("BASE_ONE"), mkAction("BASE_TWO")];
		const before = getCachedActionCatalog(base);
		expect(hasAction(before, "VIEW_SCOPED_ACT")).toBe(false);

		// A view/plugin registers a new action -> different name set -> new key.
		const withView = [...base, mkAction("VIEW_SCOPED_ACT")];
		const after = getCachedActionCatalog(withView);

		expect(after).not.toBe(before);
		// The newly registered action MUST appear in the next catalog — this is
		// the property the agent's "call view-dependent actions" depends on.
		expect(hasAction(after, "VIEW_SCOPED_ACT")).toBe(true);
		expect(hasAction(after, "BASE_ONE")).toBe(true);
	});

	it("invalidates when an action is unregistered", () => {
		const full = [
			mkAction("KEEP_A"),
			mkAction("KEEP_B"),
			mkAction("REMOVE_ME"),
		];
		const before = getCachedActionCatalog(full);
		expect(hasAction(before, "REMOVE_ME")).toBe(true);

		const fewer = [mkAction("KEEP_A"), mkAction("KEEP_B")];
		const after = getCachedActionCatalog(fewer);

		expect(hasAction(after, "REMOVE_ME")).toBe(false);
		expect(hasAction(after, "KEEP_A")).toBe(true);
	});

	it("does not cache when a localized-example resolver is active", () => {
		// The resolver depends on the recent message, so the catalog is
		// message-specific and must be rebuilt every turn (never cached).
		const actions = [mkAction("LOC_ALPHA"), mkAction("LOC_BETA")];
		const resolver = () => undefined;
		const first = getCachedActionCatalog(actions, resolver);
		const second = getCachedActionCatalog(actions, resolver);
		expect(second).not.toBe(first);
		// Still correct content, just rebuilt.
		expect(hasAction(first, "LOC_ALPHA")).toBe(true);
		expect(hasAction(second, "LOC_ALPHA")).toBe(true);
	});
});
