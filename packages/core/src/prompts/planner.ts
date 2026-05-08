import type { JSONSchema } from "../types/model";

export const v5PlannerTemplate = `task: Plan the next native tool calls.

rules:
- use only tools from the tools array exposed in the current context object
- plan the smallest grounded queue of useful tool calls
- include only arguments that are both grounded in the user request or prior tool results and declared by the selected tool's parameter schema
- never add undeclared tuning knobs such as model, reasoning, provider, timeout, or approval fields unless that exact parameter is listed for the selected tool
- set optional session-lifetime or reuse fields true only when the latest user message explicitly asks to keep or reuse the same agent/session; otherwise omit them or set false
- the current request is the latest user message in the rendered context; when history contains older similar requests, do not copy their task text, workdirs, URLs, ids, or stale facts into new tool arguments
- the task is not complete while the user still needs live/current/external data, filesystem/runtime state, command output, repo work, app builds, pull-request work, deployment, verification, or another side effect and a relevant exposed tool can attempt it
- if the current context includes a tool-required router decision or instruction, do not return a terminal answer until after at least one exposed non-terminal tool has run for the current request
- when a relevant exposed tool can attempt the needed work, call that tool instead of replying that the current context cannot browse, search, run commands, inspect, build, deploy, or verify
- prior attachments, memory, or conversation snippets are not a substitute for an explicit current request to run, check, fetch, inspect, build, deploy, verify, or look something up now; use a relevant exposed tool for the current turn
- if the task is complete or the only next step is speaking to the user, return no toolCalls and set messageToUser
- do not invent tool names, connector names, providers, ids, or benchmark ids

return:
JSON object only. No markdown, no prose, no XML, no legacy formats.

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
