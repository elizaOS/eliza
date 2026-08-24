/**
 * Covers the planner prompt contract exported from prompts/planner.ts the way
 * its consumers use it: `renderPlannerModelInput` derives stage instructions
 * by splitting the template on its single `context_object:` marker, every
 * `{{placeholder}}` must be one the renderer supplies, and planner outputs are
 * accepted or rejected according to the JSON-Schema subset `plannerSchema`
 * declares (required keys, closed envelope, permissive tool args, optional
 * boolean completion signal). Deterministic: pure data validation, no model,
 * runtime, or database.
 */
import { describe, expect, it } from "vitest";
import { plannerSchema, plannerTemplate } from "./planner";

type SchemaNode = {
	additionalProperties?: boolean;
	items?: SchemaNode;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	type?: string | string[];
};

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "array":
			return Array.isArray(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "number":
			return typeof value === "number" && !Number.isNaN(value);
		case "object":
			return (
				typeof value === "object" && value !== null && !Array.isArray(value)
			);
		case "string":
			return typeof value === "string";
		default:
			return true;
	}
}

function collectSchemaErrors(
	value: unknown,
	schema: SchemaNode,
	path: string,
	errors: string[],
): void {
	const expectedTypes = Array.isArray(schema.type)
		? schema.type
		: schema.type
			? [schema.type]
			: [];
	if (
		expectedTypes.length > 0 &&
		!expectedTypes.some((type) => matchesType(value, type))
	) {
		errors.push(`${path || "output"}: expected ${expectedTypes.join("|")}`);
		return;
	}
	if (matchesType(value, "object")) {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				errors.push(`${path || "output"}: missing required "${key}"`);
			}
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(record)) {
				if (!(key in (schema.properties ?? {}))) {
					errors.push(`${path || "output"}: unexpected property "${key}"`);
				}
			}
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (key in record) {
				collectSchemaErrors(
					record[key],
					child,
					path ? `${path}.${key}` : key,
					errors,
				);
			}
		}
	}
	if (matchesType(value, "array") && schema.items) {
		for (const [index, item] of (value as unknown[]).entries()) {
			collectSchemaErrors(item, schema.items, `${path}[${index}]`, errors);
		}
	}
}

function validatePlannerOutput(output: unknown): string[] {
	const errors: string[] = [];
	collectSchemaErrors(output, plannerSchema as SchemaNode, "", errors);
	return errors;
}

function findEmptyPropertiesShapes(node: unknown, path: string): string[] {
	const found: string[] = [];
	if (Array.isArray(node)) {
		for (const [index, item] of node.entries()) {
			found.push(...findEmptyPropertiesShapes(item, `${path}[${index}]`));
		}
		return found;
	}
	if (typeof node !== "object" || node === null) return found;
	const record = node as Record<string, unknown>;
	if ("properties" in record) {
		const properties = record.properties;
		if (
			typeof properties !== "object" ||
			properties === null ||
			Object.keys(properties).length === 0
		) {
			found.push(path);
		}
	}
	for (const [key, value] of Object.entries(record)) {
		found.push(...findEmptyPropertiesShapes(value, `${path}.${key}`));
	}
	return found;
}

describe("plannerTemplate", () => {
	it("carries exactly one context_object marker so the consumer split isolates instructions", () => {
		const segments = plannerTemplate.split("context_object:");
		expect(segments).toHaveLength(2);
		expect(segments[0]).toContain("task: Plan next native tool calls.");
		expect(segments[0]).toContain("rules:");
		expect(segments[1]).toContain("{{contextObject}}");
		expect(segments[1]).toContain("{{trajectory}}");
	});

	it("keeps the instruction prefix free of unrendered placeholders", () => {
		const instructions = plannerTemplate.split("context_object:")[0];
		expect(instructions.match(/\{\{[a-zA-Z0-9_]+\}\}/g)).toBeNull();
	});

	it("uses only renderer-supplied placeholders, each exactly once", () => {
		const placeholders = [
			...plannerTemplate.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g),
		].map((match) => match[1]);
		expect(placeholders).toEqual(["contextObject", "trajectory"]);
	});
});

describe("plannerSchema", () => {
	it("accepts a fully populated planner output", () => {
		const output = {
			completed: false,
			messageToUser: "",
			toolCalls: [
				{
					args: {
						eliza_turn_scope: "more_work_pending",
						url: "https://example.com/price",
					},
					id: "call-1",
					name: "WEB_FETCH",
				},
			],
			thought: "Fetch the current price before answering",
		};
		expect(validatePlannerOutput(output)).toEqual([]);
	});

	it("accepts the minimal no-tool output with an empty queue", () => {
		expect(
			validatePlannerOutput({ thought: "no tool fits", toolCalls: [] }),
		).toEqual([]);
	});

	it("rejects outputs missing a required envelope key", () => {
		expect(validatePlannerOutput({ toolCalls: [] })).toContain(
			'output: missing required "thought"',
		);
		expect(validatePlannerOutput({ thought: "thinking" })).toContain(
			'output: missing required "toolCalls"',
		);
	});

	it("rejects an unknown top-level key while keeping the declared four", () => {
		const errors = validatePlannerOutput({
			nextStep: "spawn",
			thought: "thinking",
			toolCalls: [],
		});
		expect(errors).toContain('output: unexpected property "nextStep"');
	});

	it("requires name on every tool call and tolerates a bare named call", () => {
		const unnamed = validatePlannerOutput({
			thought: "run it",
			toolCalls: [{ args: { command: "ls" } }],
		});
		expect(unnamed).toContain('toolCalls[0]: missing required "name"');
		expect(
			validatePlannerOutput({
				thought: "run it",
				toolCalls: [{ name: "SHELL" }],
			}),
		).toEqual([]);
	});

	it("rejects nesting arguments under a parameters key on a tool call", () => {
		const errors = validatePlannerOutput({
			thought: "run it",
			toolCalls: [{ name: "SHELL", parameters: { command: "ls" } }],
		});
		expect(errors).toContain('toolCalls[0]: unexpected property "parameters"');
	});

	it("keeps tool args permissive for strict-grammar providers", () => {
		const emptyArgs = validatePlannerOutput({
			thought: "grounded",
			toolCalls: [{ name: "X", args: {} }],
		});
		expect(emptyArgs).toEqual([]);
		const arbitraryArgs = validatePlannerOutput({
			thought: "grounded",
			toolCalls: [
				{
					name: "X",
					args: { deep: { list: ["a", 2, null] }, note: "" },
				},
			],
		});
		expect(arbitraryArgs).toEqual([]);
	});

	it("leaves completed optional and typed as boolean", () => {
		expect(
			validatePlannerOutput({
				completed: true,
				thought: "done",
				toolCalls: [],
			}),
		).toEqual([]);
		const wrongType = validatePlannerOutput({
			completed: "false",
			thought: "done",
			toolCalls: [],
		});
		expect(wrongType).toContain("completed: expected boolean");
	});
});

describe("plannerSchema provider compatibility", () => {
	it("declares no empty properties shape anywhere in the schema", () => {
		expect(findEmptyPropertiesShapes(plannerSchema, "plannerSchema")).toEqual(
			[],
		);
	});
});
