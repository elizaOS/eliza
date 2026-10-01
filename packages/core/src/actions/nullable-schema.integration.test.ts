/** Nullable updates survive model-schema conversion and canonical tool admission. */
import { expect, test } from "vitest";
import type { Action } from "../types/components";
import { actionToTool, buildPlannerToolsFromActions } from "./to-tool";
import { validateToolArgs } from "./validate-tool-args";

const action: Action = {
	name: "UPDATE_SCHEDULE",
	description:
		"Update a selected schedule, clearing repetition with explicit null.",
	similes: [],
	examples: [],
	validate: async () => true,
	handler: async () => {
		throw new Error("Schema admission regression must not execute an action");
	},
	parameters: [
		{
			name: "schedule",
			description: "Reviewed schedule update",
			required: true,
			schema: {
				type: "object",
				required: ["title", "recurrence"],
				additionalProperties: false,
				properties: {
					title: { type: "string" },
					recurrence: {
						anyOf: [
							{ type: "string", enum: ["daily", "weekly"] },
							{ type: "null" },
						],
					},
					optional: { type: "null" },
					fallback: { type: "string", default: "default value" },
				},
			},
		},
	],
};

test("nullable schedule update crosses planner, wire JSON and admission without losing explicit null", () => {
	const tools = buildPlannerToolsFromActions([action]);
	expect(tools).toHaveLength(1);
	const schema = actionToTool(action).function.parameters;
	expect(tools[0]?.parameters).toEqual(schema);
	expect(JSON.stringify(schema)).toContain('"type":"null"');
	for (const recurrence of [null, "daily", "weekly"]) {
		const input = {
			schedule: {
				title: "Reviewed",
				recurrence,
				optional: null,
				fallback: "chosen",
			},
		};
		const admitted = validateToolArgs(
			action,
			JSON.parse(JSON.stringify(input)),
		);
		expect(admitted.valid).toBe(true);
		expect(admitted.errors).toEqual([]);
		expect(admitted.args).toEqual(input);
	}
	const omittedOptional = validateToolArgs(action, {
		schedule: { title: "Reviewed", recurrence: null },
	});
	expect(omittedOptional.args).toEqual({
		schedule: {
			title: "Reviewed",
			recurrence: null,
			fallback: "default value",
		},
	});
	for (const schedule of [
		{ title: "Reviewed" },
		{ title: "Reviewed", recurrence: undefined },
		{ title: "Reviewed", recurrence: false },
		{ title: "Reviewed", recurrence: 0 },
		{ title: "Reviewed", recurrence: [] },
		{ title: "Reviewed", recurrence: "invalid" },
		{ title: null, recurrence: null },
	]) {
		expect(validateToolArgs(action, { schedule }).valid).toBe(false);
	}
	// Strict native-tool wires encode an omitted optional argument as explicit
	// null; `fallback` does not declare nullability, so its null is the absence
	// encoding and resolves to the declared default instead of failing admission.
	const wireNullOptional = validateToolArgs(action, {
		schedule: { title: "Reviewed", recurrence: null, fallback: null },
	});
	expect(wireNullOptional.valid).toBe(true);
	expect(wireNullOptional.args).toEqual({
		schedule: {
			title: "Reviewed",
			recurrence: null,
			fallback: "default value",
		},
	});
});

// Retain an explicitly declared nullable enum at both schema and admission boundaries.
test("nullable enums retain their null branch in planner schema and admission", () => {
	const enumAction: Action = {
		...action,
		parameters: [
			{
				name: "value",
				description: "Explicitly nullable enum",
				required: true,
				schema: { type: "null", enum: [null, "non-null"] },
			},
		],
	};
	const schema = actionToTool(enumAction).function.parameters;
	expect(schema.properties?.value.enum).toEqual([null, "non-null"]);
	const admitted = validateToolArgs(enumAction, JSON.parse('{"value":null}'));
	expect(admitted).toMatchObject({
		valid: true,
		args: { value: null },
		errors: [],
	});
	expect(validateToolArgs(enumAction, { value: "non-null" }).valid).toBe(false);
});
