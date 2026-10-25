/** Nullable updates survive model-schema conversion and canonical tool admission. */
import { expect, test } from "vitest";
import {
	actionToTool,
	buildPlannerToolsFromActions,
} from "../src/actions/to-tool";
import { validateToolArgs } from "../src/actions/validate-tool-args";
import type { Action } from "../src/types/components";

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
		{ title: "Reviewed", recurrence: null, fallback: null },
	]) {
		expect(validateToolArgs(action, { schedule }).valid).toBe(false);
	}
});

test("transport omission does not weaken explicit-null admission for direct callers", () => {
	const omitted = validateToolArgs(action, {
		schedule: { title: "Reviewed", recurrence: null },
	});
	expect(omitted.valid).toBe(true);
	expect(omitted.args.schedule).toEqual({
		title: "Reviewed",
		recurrence: null,
		fallback: "default value",
	});
	// Only provider restoration knows which nulls encode omitted wire keys.
	// Canonical admission cannot silently convert an invalid explicit value
	// into a default, including inside an otherwise valid nullable update.
	for (const fallback of [null, false, 0, [], {}]) {
		const rejected = validateToolArgs(action, {
			schedule: { title: "Reviewed", recurrence: null, fallback },
		});
		expect(rejected.valid).toBe(false);
		expect(
			rejected.errors.some((error) => error.includes("schedule.fallback")),
		).toBe(true);
	}
	const optionalAction: Action = {
		...action,
		parameters: [
			{
				name: "note",
				description: "Optional text",
				required: false,
				schema: { type: "string" },
			},
		],
	};
	expect(validateToolArgs(optionalAction, {}).valid).toBe(true);
	expect(validateToolArgs(optionalAction, { note: null }).valid).toBe(false);
	expect(validateToolArgs(optionalAction, { note: "chosen" }).args).toEqual({
		note: "chosen",
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
