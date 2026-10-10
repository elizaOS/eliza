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

/** Which deferred sources this evaluator call can restore. */
export interface EvaluatorRestorableContext {
  /** Selected or background-reviewed dialogue left originals out. */
  history: boolean;
  /** Provider bodies were deferred behind references. */
  providers: boolean;
}

const ALL_RESTORABLE: EvaluatorRestorableContext = {
  history: true,
  providers: true,
};

/**
 * Restoration decisions applicable to the current deferred sources. The
 * dynamic decision state advertises these; the stable response schema retains
 * the protocol superset, and the runtime rejects unavailable restoration.
 */
export function evaluatorContextRouteNames(
  restorable: EvaluatorRestorableContext = ALL_RESTORABLE,
): Array<keyof typeof EVALUATOR_CONTEXT_ROUTES> {
  return [
    ...(restorable.history ? (["RESTORE_HISTORY"] as const) : []),
    ...(restorable.providers ? (["RESTORE_PROVIDERS"] as const) : []),
    ...(restorable.history && restorable.providers
      ? (["RESTORE_FULL"] as const)
      : []),
  ];
}

/** Restoration guidance limited to the routes this call can honor. */
export function evaluatorRestorationRule(
  restorable: EvaluatorRestorableContext,
): string {
  if (restorable.history && restorable.providers)
    return "- Choose one restoration decision only for missing evidence, not merely omitted categories: RESTORE_HISTORY for a specific missing original dialogue constraint, correction, referent or historical fact; RESTORE_PROVIDERS for needed content advertised by a deferred provider reference; RESTORE_FULL only when both dialogue and provider evidence are independently needed. Explain those deficits in thought. A missing provider body alone does not require history. Missing live-record fields are tool work when the provider reference does not promise them: recommend a grounded queued read or discovery needed to load its schema, or CONTINUE to plan that read. Restoring dialogue cannot establish current record timestamps, latest ordering or fields absent from the full provider. Do not discard a useful queued discovery merely because a view advertises a capability; a capability name is not a loaded callable schema. Restoration decisions require success=false and no messageToUser/copyToClipboard; they cannot simultaneously select a queued call or finish. The runtime restores complete originals in one tool-free evaluator call. Preserve full restoration when both deficits exist; never infer omitted facts or repeat completed mutations.\n";
  if (restorable.history)
    return "- Choose RESTORE_HISTORY only for missing evidence, not merely omitted dialogue: a specific missing original dialogue constraint, correction, referent or historical fact. Explain that deficit in thought. Missing live-record fields are tool work: recommend a grounded queued read or discovery needed to load its schema, or CONTINUE to plan that read. Restoring dialogue cannot establish current record timestamps, latest ordering or live-record fields. Do not discard a useful queued discovery merely because a view advertises a capability; a capability name is not a loaded callable schema. RESTORE_HISTORY requires success=false and no messageToUser/copyToClipboard; it cannot simultaneously select a queued call or finish. The runtime restores complete originals in one tool-free evaluator call; never infer omitted facts or repeat completed mutations.\n";
  if (restorable.providers)
    return "- Choose RESTORE_PROVIDERS only for missing evidence, not merely omitted categories: needed content advertised by a deferred provider reference. Explain that deficit in thought. Missing live-record fields are tool work when the provider reference does not promise them: recommend a grounded queued read or discovery needed to load its schema, or CONTINUE to plan that read. Do not discard a useful queued discovery merely because a view advertises a capability; a capability name is not a loaded callable schema. RESTORE_PROVIDERS requires success=false and no messageToUser/copyToClipboard; it cannot simultaneously select a queued call or finish. The runtime restores complete provider content in one tool-free evaluator call; never infer omitted facts or repeat completed mutations.\n";
  return "";
}

export const evaluatorReceiptSelectionRule =
  "- For every completed change claimed in messageToUser or an approved terminal reply, select effectReceiptIds from THIS turn's supplied effectReceipts: only applied commits or replayed no-ops confirming a prior commit, never previews, failed/uncertain outcomes or rolled-back receipts. Do not invent IDs or select another operation/resource's proof. Keep IDs out of the reply; without completed-change claims, omit effectReceiptIds or use [].";

export function evaluatorTemplateForQueue(
  _hasQueuedCalls: boolean,
  _clipboardAvailable = true,
  _requiresReplyField = false,
): string {
  return `task: Evaluate latest action; route planner-loop next step.

routes:
- FINISH: the task is complete or should stop
- NEXT_RECOMMENDED: one valid queued tool should run next before replanning
- CONTINUE: ask the planner to discover or plan remaining work; an empty queue is not a blocker

rules:
- For document extraction, verification codes, reference numbers and other identifiers are values in the document text, not file hashes. Report the matching content value. A request to verify a write does not request its checksum: report integrity metadata only if the user explicitly asks for a hash, checksum or revision. Copy exact values verbatim.
- Judge accumulated results against every explicit requested outcome; no clause is optional because another seems central. Retrieval proves information, not visible navigation. An open/navigate request requires successful navigation THIS turn; page/context metadata may be stale. If only navigation remains, navigate without repeating the successful lookup, then answer. Continue while any requested outcome has an available tool.
- No search matches proves only that query/filter result, not an empty store. Distinguish messages, saved memories, document headers and content; remembered chat is not a freshly verified saved record.
- A next/latest-item projection is not an exhaustive list or count. Source freshness does not establish result coverage. Match the returned selection and checked window to the requested scope; obtain the full scoped read before claiming an agenda, total or availability.
- A failed search requesting pagination or different filters supplies no matching records; counts and retry instructions do not reveal contents. For a fact absent from supplied conversation, retry as supported or search more specifically. Never invent it or borrow details from another person, story or note. If retrieval cannot continue, report the missing evidence.
- Reading a live page requires page content returned after THIS turn's navigation, even for familiar URLs. A URL/title, earlier answer or historical chat quotation does not prove a fresh read. If only navigation succeeded, read before reporting contents.
- Describe only controls marked visible in the renderer snapshot; registered hidden controls and capabilities do not prove visibility.
- Opening a view does not select a requested day, record, document, tab or item. Require a successful UI selection/open interaction for that target or fresh rendered state proving it selected and visible. A database read/search and parent-view open are insufficient; continue with an available registered scoped interaction action, or discover one if missing. VIEWS only lists or opens views; do not invent an interaction operation. If no supported interaction is available, report that limitation rather than claim target selection.
- success=true needs completed tool result evidence; planning/read/search alone do not satisfy write/send/save/create/update/delete/payment/transfer
- Compare returned artifact fields with explicit requested values. For exact text or byte requests, compare the original request with executed arguments and returned content, including leading/trailing whitespace and final newlines; a successful write receipt proves the submitted value, not that it matches the request. Whole-file data.finalLineEnding=none contradicts an explicitly required final newline; do not mark that outcome complete. LF, CRLF and CR identify the exact suffix; an absent field makes no boundary claim. Correct only the affected artifact when authorized and unambiguous, without duplicates. Describe the verified stored value, not the intended value.
- confirmation/owner approval/missing input/MFA/human handoff => FINISH success=false; never bypass with lower-level tool
- Current decision state hasUnresolvedToolFailure=true forbids success=true. When ending a turn with an unrecovered failed operation, use FINISH success=false, even when reporting the failed attempt fulfills the user request. Include successful results and the failure cause in messageToUser; do not repeat an operation merely to turn success true.
- more_work_pending (plannerCompleted=false) requires an explicit completion declaration. You may supersede it with FINISH success=true only when requestFullyCovered=true and outcomeCoverage accounts for every advertised intent as completed using successful evidence step IDs, no queued work remains, and no failure is unresolved. Judge every clause of the full original request, including constraints absent from the intent list. Coverage is your semantic judgment; it never substitutes for effect receipts. Otherwise continue without repeating completed operations; a blocker may stop with FINISH success=false.
- terminal planner text that narrates work, exposes tool/function syntax, or says tool needed without executed result => CONTINUE; do not reuse as messageToUser
- NEXT_RECOMMENDED when the next queued tool remains grounded in results and advances an unfinished outcome. Select recommendedToolCallId from the current decision state's queued IDs; preserve planned order and prerequisites. An empty queue forbids NEXT_RECOMMENDED. CONTINUE when the plan is missing, stale, or needs unavailable arguments/results. Queue length alone does not justify replanning.
- you cannot call tools; emit no tool args, URL-open JSON, document JSON, or JSON except evaluator result
- if an answer needs an unexecuted tool/action side effect to be true, use NEXT_RECOMMENDED for a valid grounded queued call or CONTINUE to plan the missing work; do not imagine the result or declare success before it executes
- For FINISH, when current decision state requires a reply, provide the grounded answer or necessary question in messageToUser. Otherwise use an empty string only to approve an accurate terminal planner reply, verified tool text or explicit reply suppression. Internal results and undelivered Stage-1 drafts alone are not replies. CONTINUE/restoration decisions use an empty string, not a progress draft. Never add process-status bubbles after tools finish.
- messageToUser user-visible; no internal thoughts, tool names, function syntax, arbitrary JSON/tool attempts, analysis
- When composing a deferred brief or dossier, paraphrase verified facts within their supplied dates and source scope. Omit forecasts or judgments not supported by those facts, even if earlier replies used them; prefer ending on a factual sentence.
- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Use supplied local date/time labels and their timezone; keep AM/PM consistent and omit redundant daypart summaries. A past scheduled time proves neither attendance nor completion; describe it as scheduled or past, not done. Translate other machine dates and timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.
- Use plain text or lists unless an authorized widget-formatting reference is supplied; read that reference before authoring requested controls. Preserve required tool-provided approval controls.
- Deliver the result directly; do not repeat the earlier acknowledgment, restate the whole request, or narrate that you are starting work already completed.
- messageToUser human teammate voice; no session ids (pty-*), auto task labels, or sub-agent name lists; speak as agent doing work
- Latest verifiedUserFacing=true with non-empty userFacingText is the canonical visible outcome (OAuth URL, permission card, [CONFIG:…], command output). For FINISH, use an empty messageToUser unless you add NEW task-grounded substance beyond that text, such as interpreting a table. Never add a second bubble containing only a stall/ack ("on it", "working on it", "got it").
- If setting messageToUser, ground it in THIS request's outcome in everyday language. Do not rely on a fixed canned phrase list or use a process-status ack as the whole message.
- Classify the reply's claimed outcome in replyEffectStatus: applied for a claimed committed mutation or send, even indirect or non-English wording; non_applied for a stopped, failed or clarification-only outcome; none for reads, receipt-grounded view navigation or other prose without a mutation claim. An applied claim needs committed receipt proof; the classification itself proves no execution.
- Acknowledge withdrawal of unstarted work prospectively ("I will not perform that edit"), not as completed cancellation. Rejecting or cancelling queued approvals, stored events, jobs, notes or other persisted state requires its own committed receipt; a promise not to execute the original action does not settle a pending request. Report successful reads and failed changes separately. Claim no records changed only with proof of rejection before writing; failure/uncertainty alone does not prove this or erase earlier changes.
- FINISH success=false after a failed step => plainly explain the attempt and failure from the tool result. Omit file paths, internal ids and raw logs unless explicitly requested and safe to disclose; never expose secrets or internal reasoning. Do not invent unreported authentication/settings failures.
- no raw transcripts/banners/logs unless user asked raw output
- copyToClipboard requires title + content and current decision state clipboardAvailable=true.
- thought is internal: identify confirmed outcomes and requested outcomes still missing before choosing the decision.

return:
One JSON object only. No markdown/prose/XML/legacy/extra objects.
Fields in order: thought string; success boolean; decision "FINISH"|"NEXT_RECOMMENDED"|"CONTINUE"|"RESTORE_HISTORY"|"RESTORE_PROVIDERS"|"RESTORE_FULL". Use decision, not route or contextRequest. Any requested outcome still pending with an available tool means CONTINUE or a valid NEXT_RECOMMENDED, not FINISH.

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
    requestFullyCovered: {
      type: "boolean",
      description:
        "True only after checking every clause and constraint of the complete original request against actual results, beyond the summarized intent list. Semantic judgment, not execution proof.",
    },
    outcomeCoverage: {
      type: "array",
      description:
        "Account for each advertised intent ID exactly once. Completed outcomes need successful current-trajectory evidence step IDs. Blocked or pending outcomes are not complete. Omit if coverage has not been checked.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          intentId: { type: "string" },
          status: { type: "string", enum: ["completed", "blocked", "pending"] },
          evidenceStepIds: { type: "array", items: { type: "string" } },
        },
        required: ["intentId", "status", "evidenceStepIds"],
      },
    },
    messageToUser: {
      type: "string",
      description:
        "Required string: provide the grounded outcome for FINISH when current decision state requires a reply. Use an empty string for other decisions, or to approve an accurate existing terminal reply, verified tool text or explicit reply suppression.",
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
  required: [
    "thought",
    "success",
    "decision",
    "replyEffectStatus",
    "messageToUser",
  ],
};
