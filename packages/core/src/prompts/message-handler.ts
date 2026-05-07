import type { JSONSchema } from "../types/model";

export const v5MessageHandlerTemplate = `task: Decide whether the agent should respond and which contexts are needed.

context:
{{contextObject}}

available_contexts:
{{availableContexts}}

rules:
- choose action=RESPOND only when the agent should answer or perform work for this message
- choose action=IGNORE when the message should be ignored
- choose action=STOP when the user asks the agent to stop or disengage
- contexts is a list of context ids drawn from available_contexts, such as calendar or email
- never invent context ids that are not in available_contexts
- only choose contexts when tools or context providers may be needed
- simple=true only means the reply can be sent directly when contexts is empty
- if contexts is non-empty, planning will run and simple will be ignored
- include reply only for a direct user-visible response
- thought is internal routing rationale and is not shown to the user

return:
JSON object only. No markdown, no prose, no XML, no legacy formats.`;

export const V5_MESSAGE_HANDLER_TEMPLATE = v5MessageHandlerTemplate;

export const v5MessageHandlerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			type: "string",
			enum: ["RESPOND", "IGNORE", "STOP"],
		},
		simple: { type: "boolean" },
		contexts: {
			type: "array",
			items: { type: "string" },
		},
		thought: { type: "string" },
		reply: { type: "string" },
	},
	required: ["action", "simple", "contexts", "thought"],
};

export const V5_MESSAGE_HANDLER_SCHEMA = v5MessageHandlerSchema;
