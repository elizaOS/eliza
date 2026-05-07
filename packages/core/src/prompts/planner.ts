import type { JSONSchema } from "../types/model";

export const v5PlannerTemplate = `task: Plan the next native tool calls.

rules:
- use only tools from the tools array
- plan the smallest grounded queue
- only include arguments grounded in the user request or prior tool results
- if no tool fits or the task is complete, return no toolCalls and set messageToUser

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const V5_PLANNER_TEMPLATE = v5PlannerTemplate;

export const v5PlannerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		thought: { type: "string" },
		toolCalls: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					// Tool args are arbitrary per-tool. Permissive object schema —
					// no `additionalProperties: false`, no empty `properties: {}`.
					// Strict-grammar providers (Cerebras, etc.) reject the empty
					// shape with `Object fields require at least one of:
					// 'properties' or 'anyOf' with a list of possible properties`.
					args: { type: "object" },
				},
				required: ["name"],
			},
		},
		messageToUser: { type: "string" },
	},
	required: ["thought", "toolCalls"],
};

export const V5_PLANNER_SCHEMA = v5PlannerSchema;
