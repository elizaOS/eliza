import type { JSONSchema } from "../types/model";

export const v5EvaluatorTemplate = `task: Evaluate the just-executed action and route the next planner-loop step.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

routes:
- FINISH: the task is complete or should stop
- NEXT_RECOMMENDED: one queued tool should run next before replanning
- CONTINUE: call the planner again because the queued plan is missing or stale

rules:
- evaluate the latest action result against the user's goal
- choose NEXT_RECOMMENDED only when one queued tool is clearly still grounded
- choose CONTINUE when the next step requires new planning
- messageToUser is optional progress, diagnosis, question, or final output
- copyToClipboard is optional and must include title and content
- thought is internal and not shown to the user

return:
JSON object only. No markdown, no prose, no XML, no legacy formats.`;

export const V5_EVALUATOR_TEMPLATE = v5EvaluatorTemplate;

export const v5EvaluatorSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		success: { type: "boolean" },
		decision: {
			type: "string",
			enum: ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"],
		},
		thought: { type: "string" },
		messageToUser: { type: "string" },
		copyToClipboard: {
			type: "object",
			additionalProperties: false,
			properties: {
				title: { type: "string" },
				content: { type: "string" },
				tags: {
					type: "array",
					items: { type: "string" },
				},
			},
			required: ["title", "content"],
		},
		recommendedToolCallId: { type: "string" },
	},
	required: ["success", "decision", "thought"],
};

export const V5_EVALUATOR_SCHEMA = v5EvaluatorSchema;
