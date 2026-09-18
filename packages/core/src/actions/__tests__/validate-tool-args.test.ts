/**
 * Unit tests for `actions/validate-tool-args`: validating planner-supplied tool
 * arguments against an action's parameter schema — types, required fields,
 * nested objects/arrays, enums, unexpected keys, default application — plus
 * numeric bounds and explicit omission sentinels. Pattern checks reject invalid
 * regexes and oversized inputs. Runs on hand-built
 * actions and the real `messageAction`; no live model.
 */
import { describe, expect, it } from "vitest";
import { messageAction } from "../../../../../plugins/plugin-assistant/src/features/advanced-capabilities/actions/message.ts";
import type { Action, ActionParameterSchema } from "../../types";
import {
	testSchemaPattern,
	validateSchema,
	validateToolArgs,
} from "../validate-tool-args.ts";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	};
}

const nestedAction = makeAction({
	name: "SCHEDULE_TASK",
	description: "Schedule a task",
	parameters: [
		{
			name: "title",
			description: "Task title",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "attempts",
			description: "Retry attempts",
			required: false,
			schema: { type: "integer", minimum: 1, maximum: 5, default: 1 },
		},
		{
			name: "notify",
			description: "Whether to notify",
			required: false,
			schema: { type: "boolean", default: false },
		},
		{
			name: "config",
			description: "Schedule config",
			required: true,
			schema: {
				type: "object",
				properties: {
					window: {
						type: "object",
						required: ["days"],
						properties: {
							days: { type: "integer", minimum: 1 },
							timezone: { type: "string", default: "UTC" },
						},
					} as ActionParameterSchema,
					labels: { type: "array", items: { type: "string" } },
					mode: { type: "string", enum: ["once", "repeat"], default: "once" },
				},
			},
		},
	],
});

describe("validateToolArgs", () => {
	it("validates numbers, integers, and bounds", () => {
		const errors: string[] = [];
		const numSchema = {
			type: "number" as const,
			minimum: 10,
			maximum: 100,
		};

		validateSchema(numSchema, 50, "score", errors);
		expect(errors).toHaveLength(0);

		validateSchema(numSchema, 5, "score", errors);
		expect(errors).toContain("Argument 'score' value 5 is below minimum 10");

		validateSchema(numSchema, 150, "score", errors);
		expect(errors).toContain("Argument 'score' value 150 is above maximum 100");

		const intSchema = { type: "integer" as const };
		validateSchema(intSchema, 3.14, "count", errors);
		expect(errors).toContain("Argument 'count' expected integer, got number");
	});

	it("validates flat and nested native tool args and applies optional defaults", () => {
		const result = validateToolArgs(nestedAction, {
			title: "Follow up",
			config: {
				window: { days: 3 },
				labels: ["work", "urgent"],
			},
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.args).toEqual({
			title: "Follow up",
			attempts: 1,
			notify: false,
			config: {
				window: { days: 3, timezone: "UTC" },
				labels: ["work", "urgent"],
				mode: "once",
			},
		});
	});

	it("reports missing required args", () => {
		const result = validateToolArgs(nestedAction, {
			config: { window: { days: 3 } },
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Missing required argument 'title'");
	});

	it("reports wrong primitive types and invalid array items with full paths", () => {
		const result = validateToolArgs(nestedAction, {
			title: "Follow up",
			attempts: "three",
			config: {
				window: { days: 1.5 },
				labels: ["work", 42],
			},
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				"Argument 'attempts' expected integer, got string",
				"Argument 'config.window.days' expected integer, got number",
				"Argument 'config.labels[1]' expected string, got number",
			]),
		);
		expect(result.invalidParameterNames).toEqual(["attempts", "config"]);
	});

	it("reports unexpected properties and invalid nested enum values", () => {
		const result = validateToolArgs(nestedAction, {
			title: "Follow up",
			extra: true,
			config: {
				window: { days: 2, extraWindow: true },
				mode: "daily",
			},
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				"Unexpected argument 'extra'",
				"Unexpected argument 'config.window.extraWindow'",
				"Argument 'config.mode' value 'daily' is not one of: once, repeat",
			]),
		);
	});

	it("canonicalizes transport whitespace around a string enum", () => {
		const errors: string[] = [];
		const result = validateSchema(
			{ type: "string", enum: ["utf8", "base64"] },
			"\nutf8  ",
			"encoding",
			errors,
		);

		expect(errors).toEqual([]);
		expect(result).toBe("utf8");
	});

	it("returns canonicalized enum values through validateToolArgs", () => {
		const result = validateToolArgs(nestedAction, {
			title: "Follow up",
			config: { window: { days: 2 }, mode: "\nrepeat " },
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.args?.config).toMatchObject({ mode: "repeat" });
	});

	it("preserves an exact enum whose declared value contains whitespace", () => {
		const errors: string[] = [];
		const result = validateSchema(
			{ type: "string", enum: [" utf8 "] },
			" utf8 ",
			"encoding",
			errors,
		);

		expect(errors).toEqual([]);
		expect(result).toBe(" utf8 ");
	});

	it("still rejects strings that do not trim to a declared enum", () => {
		const errors: string[] = [];
		const result = validateSchema(
			{ type: "string", enum: ["utf8", "base64"] },
			" utf-8 ",
			"encoding",
			errors,
		);

		expect(result).toBe(" utf-8 ");
		expect(errors).toEqual([
			"Argument 'encoding' value ' utf-8 ' is not one of: utf8, base64",
		]);
	});

	it("rejects non-object tool args", () => {
		const result = validateToolArgs(nestedAction, "not-json");

		expect(result).toEqual({
			valid: false,
			args: undefined,
			errors: ["Tool arguments for action SCHEDULE_TASK must be an object"],
		});
	});

	it("accepts MESSAGE canonical action parameter", () => {
		const result = validateToolArgs(messageAction, {
			action: "respond",
			id: "mock-email-2",
			folder: "inbox",
			reply: "Thanks, I received it.",
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.args).toMatchObject({
			action: "respond",
			id: "mock-email-2",
			folder: "inbox",
			reply: "Thanks, I received it.",
		});
	});

	it("rejects MESSAGE legacy discriminator aliases", () => {
		const result = validateToolArgs(messageAction, {
			__subaction: "respond",
			id: "mock-email-2",
			folder: "inbox",
			reply: "Thanks, I received it.",
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Unexpected argument '__subaction'");
	});
});

describe("testSchemaPattern (untrusted-pattern hardening)", () => {
	it("matches and rejects valid patterns normally", () => {
		expect(testSchemaPattern("^\\d+$", "123")).toEqual({ ok: true });
		expect(testSchemaPattern("^\\d+$", "abc").ok).toBe(false);
	});

	it("returns a validation error for an invalid regex instead of throwing", () => {
		const r = testSchemaPattern("(", "x");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/invalid pattern/);
	});

	it("refuses to test an over-long value without running the pattern", () => {
		const long = "a".repeat(50_001); // First rejected length above MAX_PATTERN_INPUT_LENGTH
		const start = Date.now();
		const r = testSchemaPattern("(a+)+$", long);
		expect(Date.now() - start).toBeLessThan(500);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/too long/);
	});
});

describe("unused-optional sentinel strings", () => {
	const action = {
		name: "MEM",
		description: "d",
		parameters: [
			{
				name: "content",
				description: "d",
				required: true,
				modelOmissionSentinels: ["null"],
				schema: { type: "string" as const },
			},
			{
				name: "memoryId",
				description: "d",
				required: false,
				modelOmissionSentinels: ["", "null", "undefined"],
				schema: {
					type: "string" as const,
					pattern:
						"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
				},
			},
		],
		handler: async () => ({}),
		validate: async () => true,
	} as never;

	it("omits only declared sentinel spellings on an optional parameter", () => {
		for (const sentinel of ["null", "undefined", "", " NULL "]) {
			const result = validateToolArgs(action, {
				content: "remember this",
				memoryId: sentinel,
			});
			expect(result.valid).toBe(true);
			expect(result.args).not.toHaveProperty("memoryId");
		}
	});

	it("preserves ordinary optional strings and recursive JSON Schema semantics", () => {
		const ordinaryAction = {
			...action,
			parameters: [
				...(action.parameters ?? []),
				{
					name: "freeText",
					description: "d",
					required: false,
					schema: { type: "string" as const, minLength: 0 },
				},
				{
					name: "enumValue",
					description: "d",
					required: false,
					schema: { type: "string" as const, enum: ["null"] },
				},
				{
					name: "withDefault",
					description: "d",
					required: false,
					schema: { type: "string" as const, default: "fallback" },
				},
				{
					name: "nested",
					description: "d",
					required: false,
					schema: {
						type: "object" as const,
						properties: { value: { type: "string" as const } },
					},
				},
			],
		} as never;
		const result = validateToolArgs(ordinaryAction, {
			content: "remember this",
			freeText: "",
			enumValue: "null",
			withDefault: "undefined",
			nested: { value: "null" },
		});

		expect(result.valid).toBe(true);
		expect(result.args).toMatchObject({
			freeText: "",
			enumValue: "null",
			withDefault: "undefined",
			nested: { value: "null" },
		});
	});

	it("does not change exported recursive schema validation", () => {
		const errors: string[] = [];
		const result = validateSchema(
			{
				type: "object",
				properties: {
					literal: { type: "string", default: "fallback" },
				},
			},
			{ literal: "null" },
			"structured",
			errors,
		);
		expect(errors).toEqual([]);
		expect(result).toEqual({ literal: "null" });
	});

	it("a required parameter keeps a sentinel-looking value verbatim", () => {
		const result = validateToolArgs(action, { content: "null" });
		// required "content" keeps whatever string was supplied — sentinels
		// only ever mean absent for optional properties.
		expect(result.valid).toBe(true);
		expect(result.args?.content).toBe("null");
	});

	it("a real value on the optional param still validates against its pattern", () => {
		const bad = validateToolArgs(action, {
			content: "x",
			memoryId: "not-a-uuid",
		});
		expect(bad.valid).toBe(false);
		const good = validateToolArgs(action, {
			content: "x",
			memoryId: "12345678-1234-1234-1234-123456789abc",
		});
		expect(good.valid).toBe(true);
	});
});

describe("optional sentinels are only absent when the schema rejects them", () => {
	const freeText = {
		name: "NOTE",
		description: "Write a note",
		parameters: [
			{
				name: "body",
				description: "Note body",
				required: true,
				schema: { type: "string" as const },
			},
			{
				name: "tag",
				description: "Optional free-text tag",
				required: false,
				schema: { type: "string" as const },
			},
		],
		handler: async () => undefined,
		validate: async () => true,
		examples: [],
	} as unknown as Parameters<typeof validateToolArgs>[0];

	it("keeps an optional free-text value that happens to read like a sentinel", () => {
		// "null" is a legitimate thing to write in a note. The schema accepts it,
		// so dropping it would be silent data loss on the model -> action path.
		const result = validateToolArgs(freeText, { body: "x", tag: "null" });
		expect(result.valid).toBe(true);
		expect(result.args?.tag).toBe("null");
	});

	it("keeps an optional empty string when the schema accepts it", () => {
		const result = validateToolArgs(freeText, { body: "x", tag: "" });
		expect(result.valid).toBe(true);
		expect(result.args?.tag).toBe("");
	});
});
