import { describe, expect, it } from "vitest";
import type {
	Action,
	ActionParameter,
	ActionParameterSchema,
} from "../../types";
import { actionToTool } from "../to-tool.ts";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	};
}

describe("actionToTool", () => {
	it("converts flat action parameters to a strict provider-native tool schema", () => {
		const modeParameter = {
			name: "mode",
			description: "Execution mode",
			required: false,
			options: [
				{ label: "Fast", value: "fast" },
				{ label: "Careful", value: "careful" },
			],
			schema: { type: "string", default: "fast" },
		} as ActionParameter & {
			options: Array<{ label: string; value: string }>;
		};
		const action = makeAction({
			name: "DOCUMENT",
			description: "Search indexed knowledge",
			descriptionCompressed: "Search knowledge",
			parameters: [
				{
					name: "query",
					description: "Search query",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "limit",
					description: "Maximum number of results",
					required: false,
					schema: { type: "integer", minimum: 1, maximum: 20, default: 5 },
				},
				modeParameter,
			],
		});

		const tool = actionToTool(action);

		expect(tool).toEqual({
			type: "function",
			function: {
				name: "DOCUMENT",
				description: "Search knowledge",
				strict: true,
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["query"],
					properties: {
						query: {
							type: "string",
							description: "Search query",
						},
						limit: {
							type: "integer",
							description: "Maximum number of results",
							minimum: 1,
							maximum: 20,
							default: 5,
						},
						mode: {
							type: "string",
							description: "Execution mode",
							enum: ["fast", "careful"],
							default: "fast",
						},
					},
				},
			},
		});
	});

	it("converts nested objects and arrays recursively", () => {
		const action = makeAction({
			name: "CREATE_TASK",
			description: "Create a task",
			parameters: [
				{
					name: "task",
					description: "Task payload",
					required: true,
					schema: {
						type: "object",
						properties: {
							title: {
								type: "string",
								required: true,
							} as unknown as ActionParameterSchema,
							metadata: {
								type: "object",
								properties: {
									priority: {
										type: "string",
										enum: ["low", "normal", "high"],
										default: "normal",
									},
								},
							},
							tags: { type: "array", items: { type: "string" } },
						},
					},
				},
			],
		});

		const schema = actionToTool(action).function.parameters;

		expect(schema.properties.task).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["title"],
			properties: {
				title: { type: "string" },
				metadata: {
					type: "object",
					additionalProperties: false,
					required: [],
					properties: {
						priority: {
							type: "string",
							enum: ["low", "normal", "high"],
							default: "normal",
						},
					},
				},
				tags: { type: "array", items: { type: "string" } },
			},
		});
	});

	it("rejects names that are not strict native tool names", () => {
		expect(() => actionToTool(makeAction({ name: "searchDocuments" }))).toThrow(
			/Invalid tool name 'searchDocuments'/,
		);
		expect(() => actionToTool(makeAction({ name: "1_SEARCH" }))).toThrow(
			/must match/,
		);
	});
});
