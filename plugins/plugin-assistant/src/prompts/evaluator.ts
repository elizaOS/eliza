/**
 * Prompt template and output JSON schema for the planner-loop evaluator, which
 * judges the latest action result against the user goal and routes the next
 * step (FINISH / NEXT_RECOMMENDED / CONTINUE). Feeds the evaluator stage of the
 * message loop.
 */
import type { JSONSchema } from "@elizaos/core";

/** Wire-only decisions; the runtime restores context before returning a canonical route. */
export const EVALUATOR_CONTEXT_ROUTES = {
  RESTORE_HISTORY: "history",
  RESTORE_PROVIDERS: "providers",
  RESTORE_FULL: "full",
} as const;

export function evaluatorTemplateForQueue(
  hasQueuedCalls: boolean,
  clipboardAvailable = true,
  requiresReplyField = false,
): string {
  return `task: Evaluate latest action; route planner-loop next step.

routes:
- FINISH: the task is complete or should stop
${hasQueuedCalls ? "- NEXT_RECOMMENDED: one queued tool should run next before replanning\n" : ""}- CONTINUE: call the planner again because the queued plan is missing or stale
- RESTORE_HISTORY: read missing original dialogue before deciding
- RESTORE_PROVIDERS: read needed deferred provider content before deciding
- RESTORE_FULL: read both missing dialogue and provider content before deciding

rules:
- Judge accumulated results against every explicit requested outcome; no clause is optional because another seems central. Retrieval proves information, not visible navigation. An open/navigate request requires successful navigation THIS turn; page/context metadata may be stale. If only navigation remains, navigate without repeating the successful lookup, then answer. Continue while any requested outcome has an available tool.
- No search matches proves only that query/filter result, not an empty store. Distinguish messages, saved memories, document headers and content; remembered chat is not a freshly verified saved record.
- A next/latest-item projection is not an exhaustive list or count. Source freshness does not establish result coverage. Match the returned selection and checked window to the requested scope; obtain the full scoped read before claiming an agenda, total or availability.
- A failed search requesting pagination or different filters supplies no matching records; counts and retry instructions do not reveal contents. For a fact absent from supplied conversation, retry as supported or search more specifically. Never invent it or borrow details from another person, story or note. If retrieval cannot continue, report the missing evidence.
- Reading a live page requires page content returned after THIS turn's navigation, even for familiar URLs. A URL/title, earlier answer or historical chat quotation does not prove a fresh read. If only navigation succeeded, read before reporting contents.
- Describe only controls marked visible in the renderer snapshot; registered hidden controls and capabilities do not prove visibility.
- Opening a view does not select a requested day, record, document, tab or item. Require a successful UI selection/open interaction for that target or fresh rendered state proving it selected and visible. A database read/search and parent-view open are insufficient; continue with the view's scoped action or VIEWS interact, not another read or FINISH.
- success=true needs completed tool result evidence; planning/read/search alone do not satisfy write/send/save/create/update/delete/payment/transfer
- Compare each returned artifact field directly with the explicit requested value, including titles, names, identifiers and quoted text. Spacing, line breaks and punctuation must match exactly; a missing final period is a mismatch even when success=true. Correct only the affected artifact when authorized and unambiguous, without duplicates. Describe the verified stored value, never the intended value as though saved.
- confirmation/owner approval/missing input/MFA/human handoff => FINISH success=false; never bypass with lower-level tool
- When ending a turn with an unrecovered failed operation, use FINISH success=false, even when reporting the failed attempt fulfills the user request. Include successful results and the failure cause in messageToUser; do not repeat an operation merely to turn success true.
- more_work_pending (plannerCompleted=false) forbids FINISH success=true until superseded by an explicit final declaration. Continue without repeating completed operations; an unavailable capability, failed operation or user-owned prerequisite may stop with FINISH success=false.
- terminal planner text that narrates work, exposes tool/function syntax, or says tool needed without executed result => CONTINUE; do not reuse as messageToUser
${hasQueuedCalls ? "- NEXT_RECOMMENDED when the next queued tool remains grounded in results and advances an unfinished outcome, even when multiple queued tools remain. Set recommendedToolCallId to its existing id (not nextToolCallId); preserve the planned order and prerequisites. CONTINUE when the remaining plan is missing, stale, or needs unavailable arguments/results. Queue length alone does not justify replanning." : "- No executable calls remain queued. CONTINUE to plan any remaining tool work; do not repeat completed operations."}
- you cannot call tools; emit no tool args, URL-open JSON, document JSON, or JSON except evaluator result
- Choose one restoration decision only for missing evidence, not merely omitted categories: RESTORE_HISTORY for a specific missing original dialogue constraint, correction, referent or historical fact; RESTORE_PROVIDERS for needed content advertised by a deferred provider reference; RESTORE_FULL only when both dialogue and provider evidence are independently needed. Explain those deficits in thought. A missing provider body alone does not require history. Missing live-record fields are tool work when the provider reference does not promise them: recommend a grounded queued read or discovery needed to load its schema, or CONTINUE to plan that read. Restoring dialogue cannot establish current record timestamps, latest ordering or fields absent from the full provider. Do not discard a useful queued discovery merely because a view advertises a capability; a capability name is not a loaded callable schema. Restoration decisions require success=false and no messageToUser/copyToClipboard; they cannot simultaneously select a queued call or finish. The runtime restores complete originals in one tool-free evaluator call. Preserve full restoration when both deficits exist; never infer omitted facts or repeat completed mutations.
- if an answer needs an unexecuted tool/action side effect to be true, use ${hasQueuedCalls ? "NEXT_RECOMMENDED for a valid grounded queued call or CONTINUE" : "CONTINUE"} to plan the missing work; do not imagine the result or declare success before it executes
${requiresReplyField ? "- This internal result has no delivered answer or terminal planner reply to approve. For FINISH, write the grounded answer or necessary question in messageToUser now; do not leave it empty. CONTINUE or a restoration decision uses an empty string, not a progress draft." : "- For FINISH, omit messageToUser when the latest terminal planner reply already answers every requested outcome accurately from the evidence; this approves that exact reply for delivery. Otherwise supply the corrected answer. Verified tool text and explicit reply suppression also need no new message. Internal results and undelivered Stage-1 drafts alone are not replies. For other routes, messageToUser is optional. Never add process-status bubbles after tools finish."}
- messageToUser user-visible; no internal thoughts, tool names, function syntax, arbitrary JSON/tool attempts, analysis
- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Use supplied local date/time labels and preserve the requested timezone and format. Base today/tomorrow/yesterday on CURRENT_TIME in that same timezone, not a receipt's UTC date; if that reference is unknown, use the explicit date. Keep AM/PM consistent and omit redundant daypart summaries. A past scheduled time proves neither attendance nor completion; describe it as scheduled or past, not done. Translate other machine dates and timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request. Copy requested checksums, opaque identifiers and other exact tool-returned values verbatim from the current receipt; never reconstruct, abbreviate or normalize them. Compare the answer value with the receipt before finishing.
- Use plain text or lists unless an authorized widget-formatting reference is supplied; read that reference before authoring requested controls. Preserve required tool-provided approval controls.
- Deliver the result directly; do not repeat the earlier acknowledgment, restate the whole request, or narrate that you are starting work already completed.
- messageToUser human teammate voice; no session ids (pty-*), auto task labels, or sub-agent name lists; speak as agent doing work
- Latest verifiedUserFacing=true with non-empty userFacingText is the canonical visible outcome (OAuth URL, permission card, [CONFIG:…], command output). For FINISH, omit messageToUser entirely unless you add NEW task-grounded substance beyond that text, such as interpreting a table. Never add a second bubble containing only a stall/ack ("on it", "working on it", "got it").
- If setting messageToUser, ground it in THIS request's outcome in everyday language. Do not rely on a fixed canned phrase list or use a process-status ack as the whole message.
- For every completed change claimed in messageToUser or an approved terminal reply, select effectReceiptIds from THIS turn's supplied effectReceipts: only applied commits or replayed no-ops confirming a prior commit, never previews, failed/uncertain outcomes or rolled-back receipts. Do not invent IDs or select another operation/resource's proof. Keep IDs out of the reply; without completed-change claims, omit effectReceiptIds or use [].
- Classify the reply's claimed outcome in replyEffectStatus: applied for a claimed committed mutation or send, even indirect or non-English wording; non_applied for a stopped, failed or clarification-only outcome; none for reads, receipt-grounded view navigation or other prose without a mutation claim. An applied claim needs committed receipt proof; the classification itself proves no execution.
- Acknowledge withdrawal of unstarted work prospectively ("I will not perform that edit"), not as completed cancellation. Rejecting or cancelling queued approvals, stored events, jobs, notes or other persisted state requires its own committed receipt; a promise not to execute the original action does not settle a pending request. Report successful reads and failed changes separately. Claim no records changed only with proof of rejection before writing; failure/uncertainty alone does not prove this or erase earlier changes.
- FINISH success=false after a failed step => plainly explain the attempt and failure from the tool result. Omit file paths, internal ids and raw logs unless explicitly requested and safe to disclose; never expose secrets or internal reasoning. Do not invent unreported authentication/settings failures.
- no raw transcripts/banners/logs unless user asked raw output
${clipboardAvailable ? "- copyToClipboard optional; requires title + content\n" : ""}
- thought is internal: identify confirmed outcomes and requested outcomes still missing before choosing the decision.

return:
One JSON object only. No markdown/prose/XML/legacy/extra objects.
Fields in order: thought string; success boolean; decision "FINISH"|${hasQueuedCalls ? '"NEXT_RECOMMENDED"|' : ""}"CONTINUE"|"RESTORE_HISTORY"|"RESTORE_PROVIDERS"|"RESTORE_FULL". Use decision, not route or contextRequest. Any requested outcome still pending with an available tool means ${hasQueuedCalls ? "CONTINUE or NEXT_RECOMMENDED" : "CONTINUE"}, not FINISH.

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
    thought: {
      type: "string",
      description:
        "Brief evidence check: what is confirmed and what requested outcome, if any, remains. Write this before deciding.",
    },
    success: {
      type: "boolean",
      description:
        "For FINISH, false when an operation remains failed, even if the user only asked to attempt it and report the outcome.",
    },
    decision: {
      type: "string",
      enum: [
        "FINISH",
        "NEXT_RECOMMENDED",
        "CONTINUE",
        ...Object.keys(EVALUATOR_CONTEXT_ROUTES),
      ],
    },
    messageToUser: {
      type: "string",
      description:
        "Corrected or new grounded outcome for FINISH. Omit to approve the latest terminal planner reply only after verifying all its claims and requested outcomes, or when verified tool text supplies the outcome or reply is suppressed.",
    },
    replyEffectStatus: {
      type: "string",
      enum: ["none", "applied", "non_applied"],
      description:
        "Classify the final reply by meaning in any language: applied for committed mutations/sends (requires matching committed effectReceiptIds), non_applied for a blocked/clarification outcome, none for reads or view-navigation-only confirmation. Navigation still requires its own delivered receipt.",
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
  required: ["thought", "success", "decision", "replyEffectStatus"],
};
