import type { JSONSchema } from "../types/model";

export const evaluatorTemplate = `task: Evaluate latest action; route planner-loop next step.

routes:
- FINISH: the task is complete or should stop
- NEXT_RECOMMENDED: one queued tool should run next before replanning
- CONTINUE: call the planner again because the queued plan is missing or stale

rules:
- judge latest action result against user goal
- success=true needs completed tool result evidence; planning/read/search alone do not satisfy write/send/save/create/update/delete/payment/transfer
- confirmation/owner approval/missing input/MFA/human handoff => FINISH success=false; never bypass with lower-level tool
- terminal planner text that narrates work, exposes tool/function syntax, or says tool needed without executed result => CONTINUE; do not reuse as messageToUser
- NEXT_RECOMMENDED only when exactly one queued grounded tool remains; else CONTINUE
- you cannot call tools; emit no tool args, URL-open JSON, document JSON, or JSON except evaluator result
- if answer needs unexecuted tool/action side effect to be true => CONTINUE; do not imagine result
- messageToUser optional progress/diagnosis/question/final
- messageToUser user-visible; no internal thoughts, tool names, function syntax, JSON/tool attempts, analysis
- messageToUser human teammate voice; no session ids (pty-*), auto task labels, or sub-agent name lists; speak as agent doing work
- FINISH after tool use => include concise grounded messageToUser
- no raw transcripts/banners/logs unless user asked raw output
- copyToClipboard optional; requires title + content
- thought internal, not shown

return:
One JSON object only. No markdown/prose/XML/legacy/extra objects.
Fields: success boolean; decision "FINISH"|"NEXT_RECOMMENDED"|"CONTINUE"; thought string. Use decision, not route.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const evaluatorSchema: JSONSchema = {
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

export const v5EvaluatorTemplate = evaluatorTemplate;
export const v5EvaluatorSchema = evaluatorSchema;
