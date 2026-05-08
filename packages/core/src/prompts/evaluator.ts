import type { JSONSchema } from "../types/model";

export const v5EvaluatorTemplate = `task: Evaluate the just-executed action and route the next planner-loop step.

routes:
- FINISH: the task is complete or should stop
- NEXT_RECOMMENDED: one queued tool should run next before replanning
- CONTINUE: call the planner again because the queued plan is missing or stale

rules:
- evaluate the latest action result against the user's goal
- success means the user's requested outcome is fully evidenced by completed tool results, not merely planned
- never infer that a side effect happened unless a matching successful tool result exists
- if the latest action result requires user confirmation, owner approval, missing input, MFA, or human handoff, choose FINISH with success=false; do not continue to a lower-level tool to bypass that gate
- if the user requested a write/send/save/create/update/delete/payment/transfer action and the only evidence is read/search/plan output, choose CONTINUE
- if a planner terminal message merely narrates remaining work, exposes tool/function syntax, or says it needs to call a tool without an executed tool result, choose CONTINUE and do not reuse that text as messageToUser
- choose NEXT_RECOMMENDED only when one queued tool is clearly still grounded
- choose CONTINUE when the next step requires new planning
- messageToUser is optional progress, diagnosis, question, or final output
- messageToUser is shown directly to the user; never include internal thoughts, tool names, function syntax, JSON/tool-call attempts, or analysis
- copyToClipboard is optional and must include title and content
- thought is internal and not shown to the user

return:
JSON object only. No markdown, no prose, no XML, no legacy formats.
Required top-level fields:
- success: boolean
- decision: one of "FINISH", "NEXT_RECOMMENDED", "CONTINUE"
- thought: string
Use decision, not route.
Set success=true only when completed tool results fully satisfy the user's request.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

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
