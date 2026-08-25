/**
 * Covers the Action `parameters` -> JSON Schema conversion that feeds tool
 * definitions, planner grammars, and argument validation.
 *
 * Two properties are load-bearing. `additionalProperties` must default to
 * `false` — the schema gates what a model may emit as tool arguments, so
 * defaulting open would silently accept unmodelled fields. And a parameter
 * schema with neither a `type` nor a `oneOf`/`anyOf` branch must throw with the
 * offending path rather than emit a typeless schema, because a typeless node
 * degrades the generated grammar instead of failing visibly.
 *
 * Pure conversion — no runtime, no model, no IO.
 */
import { describe, expect, it } from "vitest";

import type { Action, ActionParameter } from "../types";
import {
	actionParameterSchemaToJsonSchema,
	actionParametersToJsonSchema,
	actionToJsonSchema,
	normalizeActionJsonSchema,
} from "./action-schema.ts";

const param = (overrides: Partial<ActionParameter>): ActionParameter =>
	({
		name: "value",
		schema: { type: "string" },
		...overrides,
	}) as ActionParameter;

describe("actionParametersToJsonSchema", () => {
	it("emits an object schema with properties and an empty required list", () => {
		expect(actionParametersToJsonSchema([param({ name: "text" })])).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
			required: [],
			additionalProperties: false,
		});
	});

	it("closes the schema by default and opens it only on explicit opt-in", () => {
		expect(actionParametersToJsonSchema([]).additionalProperties).toBe(false);
		expect(
			actionParametersToJsonSchema([], { allowAdditionalProperties: false })
				.additionalProperties,
		).toBe(false);
		expect(
			actionParametersToJsonSchema([], { allowAdditionalProperties: true })
				.additionalProperties,
		).toBe(true);
	});

	it("lists only required parameters, preserving declaration order", () => {
		const schema = actionParametersToJsonSchema([
			param({ name: "a", required: true }),
			param({ name: "b" }),
			param({ name: "c", required: true }),
		]);
		expect(schema.required).toEqual(["a", "c"]);
		expect(Object.keys(schema.properties)).toEqual(["a", "b", "c"]);
	});

	it("defaults to an empty schema for no parameters", () => {
		expect(actionParametersToJsonSchema()).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});
	});

	it("folds parameter examples into the description", () => {
		const schema = actionParametersToJsonSchema([
			param({
				name: "text",
				description: "The body",
				examples: ["hello", "hi"],
			} as Partial<ActionParameter>),
		]);
		expect(schema.properties.text?.description).toContain("The body");
		expect(schema.properties.text?.description).toContain("hello");
	});
});

describe("actionParameterSchemaToJsonSchema", () => {
	it("carries scalar constraints through", () => {
		expect(
			actionParameterSchemaToJsonSchema({
				type: "number",
				minimum: 1,
				maximum: 10,
			} as never),
		).toMatchObject({ type: "number", minimum: 1, maximum: 10 });
	});

	it("converts nested object properties", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "object",
			properties: { inner: { type: "string" } },
		} as never);
		expect(schema.properties?.inner).toMatchObject({ type: "string" });
	});

	it("converts array item schemas", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "array",
			items: { type: "integer" },
		} as never);
		expect(schema.items).toMatchObject({ type: "integer" });
	});

	it("maps oneOf and anyOf branches recursively", () => {
		const anyOf = actionParameterSchemaToJsonSchema({
			anyOf: [{ type: "string" }, { type: "number" }],
		} as never);
		expect(anyOf.anyOf).toHaveLength(2);
		const oneOf = actionParameterSchemaToJsonSchema({
			oneOf: [{ type: "boolean" }],
		} as never);
		expect(oneOf.oneOf).toHaveLength(1);
	});

	it("throws with the offending path when no type or branch is given", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema({} as never, { path: "outer.inner" }),
		).toThrow(/outer\.inner/);
	});

	it("rejects an unsupported type rather than passing it through", () => {
		expect(() =>
			actionParameterSchemaToJsonSchema({ type: "bigint" } as never, {
				path: "p",
			}),
		).toThrow();
	});
});

describe("actionToJsonSchema", () => {
	it("uses the action's parameters and additional-parameter policy", () => {
		const action = {
			name: "SEND",
			parameters: [param({ name: "text", required: true })],
			allowAdditionalParameters: true,
		} as unknown as Action;
		expect(actionToJsonSchema(action)).toMatchObject({
			type: "object",
			required: ["text"],
			additionalProperties: true,
		});
	});

	it("treats an action with no parameters as a closed empty object", () => {
		expect(actionToJsonSchema({ name: "NOOP" } as unknown as Action)).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});
	});
});

describe("normalizeActionJsonSchema", () => {
	it("re-emits an action's parameters in the core shape without losing structure", () => {
		const normalized = normalizeActionJsonSchema({
			parameters: [
				param({ name: "text", required: true, description: "body" }),
				param({
					name: "count",
					schema: { type: "integer" },
				} as Partial<ActionParameter>),
			],
		} as Pick<Action, "parameters" | "allowAdditionalParameters">);
		expect(normalized).toMatchObject({
			type: "object",
			required: ["text"],
			properties: {
				text: { type: "string" },
				count: { type: "integer" },
			},
		});
	});

	it("preserves nested array item structure", () => {
		const normalized = normalizeActionJsonSchema({
			parameters: [
				param({
					name: "items",
					schema: { type: "array", items: { type: "string" } },
				} as Partial<ActionParameter>),
			],
		} as Pick<Action, "parameters" | "allowAdditionalParameters">);
		expect(
			(normalized.properties as Record<string, { items?: unknown }>).items
				?.items,
		).toMatchObject({ type: "string" });
	});

	it("carries the additional-parameter policy through", () => {
		expect(
			normalizeActionJsonSchema({
				parameters: [],
				allowAdditionalParameters: true,
			} as Pick<Action, "parameters" | "allowAdditionalParameters">)
				.additionalProperties,
		).toBe(true);
		expect(
			normalizeActionJsonSchema({ parameters: [] } as Pick<
				Action,
				"parameters" | "allowAdditionalParameters"
			>).additionalProperties,
		).toBe(false);
	});
});
