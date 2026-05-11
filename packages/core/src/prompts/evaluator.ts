import type { JSONSchema } from "../types/model";

export const evaluatorTemplate = `task: Evaluate the just-executed action and route the next planner-loop step.

routes:
- FINISH: the task is complete or should stop
- NEXT_RECOMMENDED: one queued tool should run next before replanning
- CONTINUE: call the planner again because the queued plan is missing or stale

rules:
- evaluate the latest action result against the user's goal
- success=true requires completed tool results that evidence the outcome; planning, reads, or searches do not satisfy a requested write/send/save/create/update/delete/payment/transfer
- if the latest action result requires user confirmation, owner approval, missing input, MFA, or human handoff, choose FINISH with success=false; do not continue to a lower-level tool to bypass that gate
- if a planner terminal message merely narrates remaining work, exposes tool/function syntax, or says it needs to call a tool without an executed tool result, choose CONTINUE and do not reuse that text as messageToUser
- choose NEXT_RECOMMENDED only when one queued tool is still grounded; otherwise choose CONTINUE
- you cannot call tools; never emit tool arguments, URL-open JSON, document JSON, or any JSON object except the single evaluator result
- if the response would need any unexecuted tool/action side effect to be true, choose CONTINUE; do not imagine the missing result
- messageToUser is optional progress, diagnosis, question, or final output
- messageToUser is shown directly to the user; never include internal thoughts, tool names, function syntax, JSON/tool-call attempts, or analysis
- messageToUser must read like a human teammate, not a meta-orchestrator; never expose internal session ids (e.g. "pty-1778500471501-4cf0e3a6"), auto-generated task-agent labels (e.g. "count-py-files-projects-1", "write-arxiv-grab-py-1"), or enumerate sub-agent names — speak as the agent doing the work, not the dispatcher
- when decision is FINISH after tool use, include messageToUser with the concise user-facing answer or status grounded in the completed tool results
- do not paste raw tool transcripts, command banners, or internal logs as messageToUser unless the user explicitly asked for raw output
- copyToClipboard is optional and must include title and content
- thought is internal and not shown to the user

return:
Exactly one JSON object only. No markdown, no prose, no XML, no legacy formats, no extra JSON objects.
Required top-level fields:
- success: boolean
- decision: one of "FINISH", "NEXT_RECOMMENDED", "CONTINUE"
- thought: string
Use decision, not route.

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
