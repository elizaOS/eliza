import type { JSONSchema, ToolDefinition } from "../types/model";

export const V5_MESSAGE_HANDLER_TOOL_NAME = "MESSAGE_HANDLER_PLAN";

export const v5MessageHandlerTemplate = `task: Decide processMessage and the plan for this message.

context:
{{contextObject}}

available_contexts:
{{availableContexts}}

rules:
- choose processMessage=RESPOND only when the agent should answer or perform work for this message
- choose processMessage=IGNORE when the message should be ignored
- choose processMessage=STOP when the user asks the agent to stop or disengage
- plan.contexts is a list of context ids drawn from available_contexts, such as calendar or email
- never invent context ids that are not in available_contexts
- choose plan.contexts=["simple"] (and only "simple") when the agent can answer directly from its own knowledge with no tools or external data; this is the shortcut path and includes plan.reply
- do not choose "simple" for requests to change, persist, update, or remember agent/user settings, preferences, identity, persona, character, response style, or future behavior; select settings and any other relevant context instead
- otherwise list every relevant context id; planning will run and tools will be selected from those contexts
- include plan.reply only on the simple shortcut path (plan.contexts=["simple"])
- thought is internal routing rationale and is not shown to the user
- call ${V5_MESSAGE_HANDLER_TOOL_NAME} exactly once with the plan
- do not answer in plain text

return:
Use the ${V5_MESSAGE_HANDLER_TOOL_NAME} tool. Do not return JSON as message text.`;

export const V5_MESSAGE_HANDLER_TEMPLATE = v5MessageHandlerTemplate;

export const v5MessageHandlerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		processMessage: {
			type: "string",
			enum: ["RESPOND", "IGNORE", "STOP"],
		},
		plan: {
			type: "object",
			additionalProperties: false,
			properties: {
				contexts: {
					type: "array",
					items: { type: "string" },
				},
				reply: { type: "string" },
			},
			required: ["contexts"],
		},
		thought: { type: "string" },
	},
	required: ["processMessage", "plan", "thought"],
};

export const V5_MESSAGE_HANDLER_SCHEMA = v5MessageHandlerSchema;

export const v5DirectMessageHandlerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		plan: v5MessageHandlerSchema.properties?.plan as JSONSchema,
		thought: { type: "string" },
	},
	required: ["plan", "thought"],
};

export const V5_DIRECT_MESSAGE_HANDLER_SCHEMA = v5DirectMessageHandlerSchema;

export function createV5MessageHandlerTool(options?: {
	directMessage?: boolean;
}): ToolDefinition {
	return {
		name: V5_MESSAGE_HANDLER_TOOL_NAME,
		description:
			"Return the Stage 1 routing plan for the current message. This tool is internal; do not use plain text for this stage.",
		type: "function",
		strict: true,
		parameters: options?.directMessage
			? v5DirectMessageHandlerSchema
			: v5MessageHandlerSchema,
	};
}
