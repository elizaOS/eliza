/**
 * Exercises the real planner-to-provider schema boundary so optional saved
 * choice bindings are never required placeholders on ordinary create calls.
 */
import type { ActionParameterSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../../../packages/core/src/actions/promote-subactions.js";
import { buildPlannerToolsFromActions } from "../../../../packages/core/src/actions/to-tool.js";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.js";
import { __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall } from "../../../plugin-openai/models/text.js";
import { createAppAction } from "./app.js";
import { createViewsAction } from "./views.js";

describe.each([
	["APP", createAppAction],
	["VIEWS", createViewsAction],
] as const)("%s optional saved choice arguments", (name, createAction) => {
	it.each([false, true])(
		"keeps taskId optional through the provider wire schema (Cerebras: %s)",
		(cerebrasMode) => {
			const family = promoteSubactionsToActions(createAction());
			if (name === "APP") {
				expect(family.map((action) => action.name)).toContain("APP_CREATE");
			}
			const normalized = normalizeNativeToolsForCall(
				buildPlannerToolsFromActions(family),
				{ cerebrasMode },
			).tools;
			if (!normalized)
				throw new Error("choice action family was not normalized");
			for (const action of family) {
				const tool = normalized[action.name] as {
					strict?: boolean;
					inputSchema: { jsonSchema: ActionParameterSchema };
				};
				const schema = tool.inputSchema.jsonSchema;
				expect(schema.properties?.taskId).toMatchObject({ type: "string" });
				expect(schema.required ?? []).not.toContain("taskId");
				expect(schema.required ?? []).not.toContain("choice");
				expect(tool.strict).toBe(false);
			}
		},
	);

	it("accepts ordinary create without a binding and still rejects mistyped taskId", () => {
		const family = promoteSubactionsToActions(createAction());
		for (const action of family.filter(
			(candidate) =>
				candidate.name === name || candidate.name === `${name}_CREATE`,
		)) {
			const args = { action: "create", intent: "Build a reading tracker" };
			expect(validateToolArgs(action, args)).toMatchObject({
				valid: true,
				args,
			});
			expect(validateToolArgs(action, { ...args, taskId: 42 }).valid).toBe(
				false,
			);
		}
	});
});
