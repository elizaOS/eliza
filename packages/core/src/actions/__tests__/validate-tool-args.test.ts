import { describe, expect, it } from "vitest";
import type { Action, ActionParameterSchema } from "../../types";
import { messageAction } from "../../features/advanced-capabilities/actions/message.ts";
import { validateToolArgs } from "../validate-tool-args.ts";

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
					} as unknown as ActionParameterSchema,
					labels: { type: "array", items: { type: "string" } },
					mode: { type: "string", enum: ["once", "repeat"], default: "once" },
				},
			},
		},
	],
});

describe("validateToolArgs", () => {
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

	it("rejects non-object tool args", () => {
		const result = validateToolArgs(nestedAction, "not-json");

		expect(result).toEqual({
			valid: false,
			args: undefined,
			errors: ["Tool arguments for action SCHEDULE_TASK must be an object"],
		});
	});

	it("accepts MESSAGE planner compatibility aliases", () => {
		const result = validateToolArgs(messageAction, {
			__subaction: "respond_to_message",
			id: "mock-email-2",
			folder: "inbox",
			reply: "Thanks, I received it.",
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.args).toMatchObject({
			__subaction: "respond_to_message",
			id: "mock-email-2",
			folder: "inbox",
			reply: "Thanks, I received it.",
		});
	});
});
