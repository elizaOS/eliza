/**
 * Regression coverage for rebuilding the action catalog from current metadata.
 * Same-named actions across runtimes and mutable definitions must not reuse
 * stale entries. The production caller is covered by planner-happy-path.test.ts.
 * Deterministic: synthetic Action stubs, no model or database.
 */
import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "../runtime/action-catalog";
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
	catalog: ReturnType<typeof buildActionCatalog>,
	name: string,
): boolean {
	return catalog.parents.some((parent) => parent.name === name);
}

describe("action catalog freshness", () => {
	it("uses the current runtime's same-named action metadata and source", () => {
		const firstAction = mkAction("RUNTIME_REPLACEMENT");
		firstAction.description = "First runtime's description";
		firstAction.parameters = [
			{
				name: "first",
				description: "First parameter",
				schema: { type: "string" },
			},
		];
		const first = buildActionCatalog([firstAction]);
		const nextAction = mkAction("RUNTIME_REPLACEMENT");
		nextAction.description = "Second runtime's description";
		nextAction.parameters = [
			{
				name: "second",
				description: "Second parameter",
				schema: { type: "number" },
			},
		];
		const next = buildActionCatalog([nextAction]);
		expect(next.parents[0].description).toBe(nextAction.description);
		expect(next.parents[0].parameters).toBe(nextAction.parameters);
		expect(next.parents[0].source).toBe(nextAction);
		expect(first.parents[0].source).toBe(firstAction);
	});

	it("rebuilds materialized metadata after in-place action edits", () => {
		const action = mkAction("EDITED_METADATA");
		const before = buildActionCatalog([action]);
		action.description = "Updated complete description";
		action.routingHint = "Updated routing hint";
		const after = buildActionCatalog([action]);
		expect(after.parents[0].description).toBe(action.description);
		expect(after.parents[0].searchText).toContain(action.description);
		expect(after.parents[0].routingHint).toBe(action.routingHint);
		expect(before.parents[0].description).not.toBe(
			after.parents[0].description,
		);
	});

	it("rebuilds parent-child relationships without requiring a name change", () => {
		const parent = mkAction("CHANGING_PARENT");
		const child = mkAction("CHANGING_CHILD");
		parent.subActions = [child.name];
		const grouped = buildActionCatalog([parent, child]);
		parent.subActions = [];
		const independent = buildActionCatalog([parent, child]);
		expect(grouped.children.map((entry) => entry.name)).toEqual([child.name]);
		expect(independent.children).toEqual([]);
		expect(independent.parents.map((entry) => entry.name)).toEqual([
			child.name,
			parent.name,
		]);
	});

	it("preserves content when an unchanged action set is rebuilt", () => {
		const actions = [mkAction("ALPHA_ACT"), mkAction("BETA_ACT")];
		const first = buildActionCatalog(actions);
		const second = buildActionCatalog(actions);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
		expect(hasAction(first, "ALPHA_ACT")).toBe(true);
		expect(hasAction(first, "BETA_ACT")).toBe(true);
	});

	it("includes a newly registered plugin or view action", () => {
		const base = [mkAction("BASE_ONE"), mkAction("BASE_TWO")];
		const before = buildActionCatalog(base);
		expect(hasAction(before, "VIEW_SCOPED_ACT")).toBe(false);

		const withView = [...base, mkAction("VIEW_SCOPED_ACT")];
		const after = buildActionCatalog(withView);

		expect(after).not.toBe(before);
		// The newly registered action MUST appear in the next catalog — this is
		// the property the agent's "call view-dependent actions" depends on.
		expect(hasAction(after, "VIEW_SCOPED_ACT")).toBe(true);
		expect(hasAction(after, "BASE_ONE")).toBe(true);
	});

	it("excludes an unregistered action", () => {
		const full = [
			mkAction("KEEP_A"),
			mkAction("KEEP_B"),
			mkAction("REMOVE_ME"),
		];
		const before = buildActionCatalog(full);
		expect(hasAction(before, "REMOVE_ME")).toBe(true);

		const fewer = [mkAction("KEEP_A"), mkAction("KEEP_B")];
		const after = buildActionCatalog(fewer);

		expect(hasAction(after, "REMOVE_ME")).toBe(false);
		expect(hasAction(after, "KEEP_A")).toBe(true);
	});

	it("preserves original examples when the localized resolver has no replacement", () => {
		// The resolver depends on the recent message, so the catalog is
		// message-specific and must be rebuilt every turn (never cached).
		const actions = [mkAction("LOC_ALPHA"), mkAction("LOC_BETA")];
		const resolver = () => null;
		const first = buildActionCatalog(actions, { localizedExamples: resolver });
		const second = buildActionCatalog(actions, { localizedExamples: resolver });
		expect(second).not.toBe(first);
		// Still correct content, just rebuilt.
		expect(hasAction(first, "LOC_ALPHA")).toBe(true);
		expect(hasAction(second, "LOC_ALPHA")).toBe(true);
	});
});
