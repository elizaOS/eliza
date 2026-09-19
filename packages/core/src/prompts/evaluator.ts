/**
 * Prompt template and output JSON schema for the planner-loop evaluator, which
 * judges the latest action result against the user goal and routes the next
 * step (FINISH / NEXT_RECOMMENDED / CONTINUE). Feeds the evaluator stage of the
 * message loop.
 */
import type { JSONSchema } from "../types/model";

export function evaluatorTemplateForQueue(
	hasQueuedCalls: boolean,
	clipboardAvailable = true,
): string {
	return `task: Evaluate latest action; route planner-loop next step.

routes:
- FINISH: answer now, including a question for required user input. success=false means the requested change is not complete; it does NOT require CONTINUE.
${hasQueuedCalls ? "- NEXT_RECOMMENDED: one queued tool should run next before replanning\n" : ""}- CONTINUE: another executable tool operation is needed now; never use merely to write an answer or ask the user a question.

rules:
- Judge accumulated results against every explicit requested outcome; no clause is optional because another seems central. Retrieval proves information, not visible navigation. An open/navigate request requires successful navigation THIS turn; page/context metadata may be stale. If only navigation remains, navigate without repeating the successful lookup, then answer. Continue only for remaining tool work whose required inputs and authorization are available.
- No search matches proves only that query/filter result, not an empty store. Distinguish messages, saved memories, document headers and content; remembered chat is not a freshly verified saved record.
- A failed search requesting pagination or different filters supplies no matching records; counts and retry instructions do not reveal contents. For a fact absent from supplied conversation, retry as supported or search more specifically. Never invent it or borrow details from another person, story or note. If retrieval cannot continue, report the missing evidence.
- Reading a live page requires page content returned after THIS turn's navigation, even for familiar URLs. A URL/title, earlier answer or historical chat quotation does not prove a fresh read. If only navigation succeeded, read before reporting contents.
- Describe only controls marked visible in the renderer snapshot; registered hidden controls and capabilities do not prove visibility.
- Opening a view does not select a requested day, record, document, tab or item. Require a successful UI selection/open interaction for that target or fresh rendered state proving it selected and visible. A database read/search and parent-view open are insufficient; continue with the view's scoped action or VIEWS interact, not another read or FINISH.
- success=true needs completed tool result evidence; planning/read/search alone do not satisfy write/send/save/create/update/delete/payment/transfer
- Compare requested artifact values with THIS turn's returned fields, preserving exact text, spacing and punctuation. Report a mismatch only when those actual values differ; earlier failures or assistant claims do not override a current saved record. Correct only a demonstrated mismatch when authorized and unambiguous, without duplicates. Describe the verified stored value.
- If remaining work requires the user's choice, missing input, approval, MFA or human handoff, FINISH success=false and ask for it in messageToUser. Include verified options already retrieved. You own this reply; do not replan merely to call REPLY. A tool being available does not supply its missing inputs or authorization. Never guess or bypass the prerequisite.
- When ending a turn with an unrecovered failed operation, use FINISH success=false, even when reporting the failed attempt fulfills the user request. Include successful results and the failure cause in messageToUser; do not repeat an operation merely to turn success true.
- more_work_pending (plannerCompleted=false) forbids FINISH success=true until superseded by an explicit final declaration. Continue without repeating completed operations; an unavailable capability, failed operation or user-owned prerequisite may stop with FINISH success=false.
- terminal planner text that narrates work, exposes tool/function syntax, or says tool needed without executed result => CONTINUE; do not reuse as messageToUser
${hasQueuedCalls ? "- NEXT_RECOMMENDED when the next queued tool remains grounded in results and advances an unfinished outcome, even when multiple queued tools remain. Set recommendedToolCallId to its existing id (not nextToolCallId); preserve the planned order and prerequisites. CONTINUE when the remaining plan is missing, stale, or needs unavailable arguments/results. Queue length alone does not justify replanning." : "- No executable calls remain queued. CONTINUE only for remaining executable tool work; otherwise FINISH with the answer or necessary question. Do not repeat completed operations."}
- you cannot call tools; emit no tool args, URL-open JSON, document JSON, or JSON except evaluator result
- If completion_context reports omitted dialogue or deferred providers and a needed constraint, referent, correction or historical fact is missing, use contextRequest="history", "providers", or "full" for both; decision=CONTINUE, success=false, no reply text/clipboard effect. The runtime restores complete originals for one tool-free evaluator call. Never infer omitted facts or repeat a completed mutation for context. Do not request full context without reported source selection or deferred references.
- if an answer needs an unexecuted tool/action side effect to be true, use ${hasQueuedCalls ? "NEXT_RECOMMENDED for a valid grounded queued call or CONTINUE" : "CONTINUE"} to plan the missing work; do not imagine the result or declare success before it executes
- For FINISH, include a concise grounded messageToUser unless verified tool text already supplies the outcome or the result explicitly suppresses a reply. Internal results and undelivered Stage-1 drafts are not replies. For other routes, messageToUser is optional. Never add process-status bubbles after tools finish.
- messageToUser user-visible; no internal thoughts, tool names, function syntax, arbitrary JSON/tool attempts, analysis
- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.
- Use plain text or lists for answers and choices. Do not author interactive widgets. Preserve required tool-provided approval controls.
- messageToUser human teammate voice; no session ids (pty-*), auto task labels, or sub-agent name lists; speak as agent doing work
- Latest verifiedUserFacing=true with non-empty userFacingText is the canonical visible outcome (OAuth URL, permission card, [CONFIG:…], command output). For FINISH, omit messageToUser entirely unless you add NEW task-grounded substance beyond that text, such as interpreting a table. Never add a second bubble containing only a stall/ack ("on it", "working on it", "got it").
- If setting messageToUser, ground it in THIS request's outcome in everyday language. Do not rely on a fixed canned phrase list or use a process-status ack as the whole message.
- Classify messageToUser with replyEffectStatus: applied for a claimed completed change, non_applied when the turn must end awaiting user input/approval or reporting a blocked/declined change, none for information/chat or a continuation with no reply claim. For every completed change claimed in messageToUser, select effectReceiptIds from THIS turn's supplied effectReceipts: only applied commits or replayed no-ops confirming a prior commit, never previews, failed/uncertain outcomes or rolled-back receipts. Do not invent IDs or select another operation/resource's proof. Keep IDs out of the reply; without completed-change claims, omit effectReceiptIds or use [].
- Acknowledge withdrawal of unstarted work prospectively ("I will not perform that edit"), not as completed cancellation. Cancelling stored events, jobs, notes or other external state requires its own committed receipt. Report successful reads and failed changes separately. Claim no records changed only with proof of rejection before writing; failure/uncertainty alone does not prove this or erase earlier changes.
- FINISH success=false after a failed step => plainly explain the attempt and failure from the tool result; no file paths, internal ids or raw logs. Do not invent unreported authentication/settings failures.
- no raw transcripts/banners/logs unless user asked raw output
${clipboardAvailable ? "- copyToClipboard optional; requires title + content\n" : ""}

return:
One JSON object only. No markdown/prose/XML/legacy/extra objects.
Fields in order: success boolean; decision "FINISH"|${hasQueuedCalls ? '"NEXT_RECOMMENDED"|' : ""}"CONTINUE". Use decision, not route. Any requested outcome still pending with grounded inputs and authorization means ${hasQueuedCalls ? "CONTINUE or NEXT_RECOMMENDED" : "CONTINUE"}, not FINISH.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;
}

export const evaluatorTemplate = evaluatorTemplateForQueue(true);

export const evaluatorSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		success: {
			type: "boolean",
			description:
				"For FINISH, false when an operation remains failed, even if the user only asked to attempt it and report the outcome.",
		},
		decision: {
			type: "string",
			enum: ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"],
			description:
				"FINISH with messageToUser when answering or asking for missing user input, even when success=false. CONTINUE only for another executable tool operation with grounded inputs and authorization, never for generating the reply. NEXT_RECOMMENDED executes a grounded queued call.",
		},
		replyEffectStatus: {
			type: "string",
			enum: ["none", "applied", "non_applied"],
			description:
				"Classify the reply claim: applied means a completed change and requires current-turn committed effectReceiptIds; non_applied means this turn ends awaiting user input/approval or reporting a blocked/declined change (FINISH, success=false, explain what is needed); none means information/chat or a continuation without a completed-change claim. Classify by meaning, regardless of wording.",
		},
		messageToUser: {
			type: "string",
			description:
				"Grounded user-facing outcome for FINISH. Omit only when verified tool text already supplies the outcome or the result explicitly suppresses a reply; internal results and undelivered drafts do not supply it.",
		},
		contextRequest: {
			type: "string",
			enum: ["history", "providers", "full"],
			description:
				"Read omitted history, deferred provider bodies, or both (full); request only missing sources reported by completion_context. Requires CONTINUE, success=false and no reply text/clipboard effect.",
		},
		effectReceiptIds: {
			type: "array",
			// Keep the wire schema within providers' structured-output subset;
			// parseEvaluatorOutput enforces nonblank, unique IDs after decoding.
			items: { type: "string" },
			description:
				"Current-turn committed effect receipts grounding the changes described in messageToUser. Never display these IDs in the reply.",
		},
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
	required: ["success", "decision", "replyEffectStatus"],
};
