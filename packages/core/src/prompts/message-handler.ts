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
- choose plan.contexts=["simple"] (and only "simple") when ALL of the following are true:
    * the message is purely conversational, a greeting, or a factual question the agent can answer from training alone
    * no external data, system state, person, document, file, schedule, calendar, email, memory, or provider is mentioned or implied
    * no action verbs like search, find, get, fetch, save, send, create, update, delete, run, execute, or call are present
    * the answer would not meaningfully change if checked against up-to-date information, world state, or memory
    * when uncertain: prefer planning over simple
- never choose "simple" if the message names a person, place, file, document, or data source; asks about schedules or past interactions ("what did I say earlier", "what's on my calendar", "how many X"); or would benefit from any tool call even if the agent could fabricate a plausible answer
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
