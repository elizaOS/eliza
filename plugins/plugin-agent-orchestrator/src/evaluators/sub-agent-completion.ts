/**
 * Response-handler evaluator that decides what the planner does with a verified
 * sub-agent `task_complete` synthetic memory: relay the sub-agent's answer
 * directly to the user, or step aside for a concrete planner follow-up.
 *
 * Most of this file is the heuristics that separate a real deliverable from
 * router/tool-transcript noise — captured `[tool output: …]` envelopes, raw
 * path/transcript leaks, loopback-vs-user-facing URLs, empty-completion
 * placeholders, and failure markers reported without positive evidence. A short
 * clean answer, or a degenerate (`length` / `content_filter`) completion, is
 * relayed once instead of re-spawned; that is the guard against the weak-model
 * re-spawn loop (elizaOS/eliza#8875). Its failure-side twin is
 * `sub-agent-failure.ts`.
 *
 * Relayed replies are verification-aware: when the durable task behind the
 * session is still `validating` (or was knocked back by a failed verification)
 * the relay carries an explicit pending/provisional note, so the user never
 * reads an unverified claim as a final result.
 */
import {
  type AgentContext,
  type IAgentRuntime,
  MESSAGE_SOURCE_SUB_AGENT,
  type Memory,
  type MessageHandlerResult,
  type ResponseHandlerEvaluator,
  SIMPLE_CONTEXT_ID,
} from "@elizaos/core";

const SUB_AGENT_SOURCE = MESSAGE_SOURCE_SUB_AGENT;
const EMPTY_COMPLETION_PLACEHOLDER =
  "sub-agent reports task complete (no captured output).";
// When the evaluator routes back to TASKS_SEND_TO_AGENT or TASKS_SPAWN_AGENT,
// the active context must satisfy their contextGate. TASKS declares coding /
// automation / agent-internal contexts, so we set `automation` — picking a
// context outside that set causes
// `executePlannedToolCall` to reject with "Action TASKS_* is not allowed
// in the current context".
const ORCHESTRATOR_CONTEXT_ID = "automation" as AgentContext;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]*]+/g;
const TOOL_OUTPUT_END_MARKER = "[/tool output]";
const TOOL_FAILURE_MARKER_RE =
  /\b(?:command not found|permission denied|no such file or directory|timed? out|timeout|exited with code|exit code [1-9]\d*|non[-\s]?zero exit|could not find|unable to find)\b/i;
const NO_RESULT_MARKER_RE =
  /\b(?:no files? found|no matching files?|no matches? found|found no files?|nothing found)\b/i;
const POSITIVE_QUANTITATIVE_EVIDENCE_RE =
  /\b(?:found|located|matched|identified|listed|returned|there (?:are|were)|total(?:ed)?|count(?:\s+is)?|contains?)\s+(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[a-z]+(?:ty|teen))\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentRecord(message: Memory): Record<string, unknown> | undefined {
  return asRecord(message.content);
}

function metadataRecord(message: Memory): Record<string, unknown> | undefined {
  return asRecord(contentRecord(message)?.metadata);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => textOf(entry))
    .filter((entry) => entry.length > 0);
}

function hasStrings(values: readonly string[] | undefined): boolean {
  return (
    Array.isArray(values) && values.some((value) => value.trim().length > 0)
  );
}

function normalizedActionHints(
  values: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
}

function hasOnlyStaleCompletionHints(values: readonly string[] | undefined) {
  const hints = normalizedActionHints(values);
  return (
    hints.length > 0 &&
    hints.every(
      (hint) =>
        hint === "TASKS" ||
        hint === "ATTACHMENT" ||
        hint === "SPAWN_AGENT" ||
        hint === "TASKS_SPAWN_AGENT",
    )
  );
}

function hasUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  return URL_IN_TEXT_RE.test(text);
}

function hasUserFacingUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const url = parseUrl(match[0]);
    if (url && !isLoopbackHost(url.hostname)) return true;
  }
  return false;
}

function hasLoopbackUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const url = parseUrl(match[0]);
    if (url && isLoopbackHost(url.hostname)) return true;
  }
  return false;
}

function isEmptyCompletionPlaceholder(text: string): boolean {
  return text.trim().toLowerCase() === EMPTY_COMPLETION_PLACEHOLDER;
}

function appendVerifiedUrl(reply: string, verifiedUrl: string): string {
  const trimmed = reply.trim();
  return trimmed ? `${trimmed}\n${verifiedUrl}` : verifiedUrl;
}

function cleanCompletionReply(reply: string | undefined): string | undefined {
  const trimmed = reply?.trim();
  if (!trimmed) return trimmed;
  const statusPrefixes = ["✅ ", "❌ ", "🚀 ", "💬 ", "⏳ ", "⚠️ "];
  const prefix = statusPrefixes.find((candidate) =>
    trimmed.startsWith(candidate),
  );
  return prefix ? trimmed.slice(prefix.length).trimStart() : trimmed;
}

function stripLoopbackUrlLines(reply: string, verifiedUrl: string): string {
  const retained = reply
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !hasLoopbackUrl(line));
  const cleaned = cleanCompletionReply(retained.join("\n")) ?? "";
  return hasUrl(cleaned) ? cleaned : appendVerifiedUrl(cleaned, verifiedUrl);
}

function bodyIsOnlyUrls(text: string): boolean {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) => {
      try {
        return new URL(line).toString().length > 0;
      } catch {
        // error-policy:J3 model text probed for URL-only lines; a parse failure means the line is not a URL (explicit invalid), not a fabricated result.
        return false;
      }
    })
  );
}

// Match absolute Unix paths under a well-known top-level directory. The
// anchored TLD set avoids false matches on URL paths (`/admin`), regex
// literals (`/^foo$/`), and bullets starting with `/` while still catching
// path leaks from Read/Bash/Edit tool transcripts.
const RAW_TOOL_PATH_RE =
  /^\/(?:Users|home|root|var|tmp|opt|etc|usr|private|mnt|srv)\/[^\s]+/m;

function looksLikeRawToolTranscript(text: string): boolean {
  return (
    text.includes("[tool output:") ||
    text.includes("[/tool output]") ||
    text.includes("Full output saved to:") ||
    RAW_TOOL_PATH_RE.test(text)
  );
}

function userFacingVerifiedUrl(urls: readonly string[]): string | undefined {
  const parsed = urls
    .map((url) => {
      try {
        return { url, parsed: new URL(url) };
      } catch {
        // error-policy:J3 untrusted candidate URL parsed; unparseable entries are dropped as invalid, never treated as valid.
        return undefined;
      }
    })
    .filter(
      (entry): entry is { url: string; parsed: URL } => entry !== undefined,
    );
  return (
    parsed.find((entry) => !isLoopbackHost(entry.parsed.hostname))?.url ??
    parsed[0]?.url
  );
}

function replyMentionsVerifiedUrl(reply: string, verifiedUrl: string): boolean {
  const trimmedReply = reply.trim();
  if (!trimmedReply) return false;
  if (trimmedReply.includes(verifiedUrl)) return true;
  const verified = parseUrl(verifiedUrl);
  if (!verified) return false;
  URL_IN_TEXT_RE.lastIndex = 0;
  for (const match of trimmedReply.matchAll(URL_IN_TEXT_RE)) {
    const candidate = parseUrl(match[0]);
    if (candidate?.toString() === verified.toString()) return true;
  }
  return false;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    // error-policy:J3 untrusted string probed as a URL; a parse failure returns the explicit "not a URL" signal (undefined).
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function looksLikeCapturedToolOutput(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  if (!firstLine.startsWith("[tool output:") || !firstLine.endsWith("]"))
    return false;
  if (lines.some((line) => line.trim().startsWith(TOOL_OUTPUT_END_MARKER))) {
    return capturedToolOutputBlocksOnly(lines);
  }
  const body = lines.slice(1).join("\n").trim();
  return body.length > 0;
}

function tailAfterEndMarker(line: string): string {
  const idx = line.indexOf(TOOL_OUTPUT_END_MARKER);
  return idx >= 0 ? line.slice(idx + TOOL_OUTPUT_END_MARKER.length).trim() : "";
}

function partitionToolOutputBlocks(lines: string[]): {
  remainder: string[];
  sawToolOutput: boolean;
  unclosed: boolean;
} {
  let insideToolOutput = false;
  let sawToolOutput = false;
  const remainder: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideToolOutput && trimmed.startsWith("[tool output:")) {
      insideToolOutput = true;
      sawToolOutput = true;
      continue;
    }
    if (insideToolOutput && trimmed.startsWith(TOOL_OUTPUT_END_MARKER)) {
      insideToolOutput = false;
      const after = tailAfterEndMarker(line);
      if (after) remainder.push(after);
      continue;
    }
    if (!insideToolOutput) remainder.push(line);
  }
  return { remainder, sawToolOutput, unclosed: insideToolOutput };
}

function capturedToolOutputBlocksOnly(lines: string[]): boolean {
  const { remainder, sawToolOutput, unclosed } =
    partitionToolOutputBlocks(lines);
  return sawToolOutput && !unclosed && remainder.join("\n").trim() === "";
}

function userFacingCompletionBody(text: string): string {
  const body = stripRouterAnnotations(text);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((line) => line.trim().startsWith(TOOL_OUTPUT_END_MARKER))) {
    return body;
  }
  const { remainder } = partitionToolOutputBlocks(lines);
  const userText = remainder.join("\n").trim();
  return userText || body;
}

function hasCleanFinalProseAfterToolOutput(text: string): boolean {
  const body = stripRouterAnnotations(text);
  if (
    !body.includes("[tool output:") ||
    !body.includes(TOOL_OUTPUT_END_MARKER)
  ) {
    return false;
  }
  const userText = userFacingCompletionBody(text);
  return (
    userText.length > 0 &&
    !isEmptyCompletionPlaceholder(userText) &&
    !looksLikeRawToolTranscript(userText)
  );
}

function stripRouterAnnotations(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body =
    lines[0]?.startsWith("[sub-agent:") === true ? lines.slice(1) : lines;
  const annotationIndex = body.findIndex((line) =>
    line.startsWith("[verification:"),
  );
  return (annotationIndex >= 0 ? body.slice(0, annotationIndex) : body)
    .join("\n")
    .trim();
}

function completionHasVerificationFailure(text: string): boolean {
  return (
    text.includes("[verification:") ||
    text.includes("NOT reachable") ||
    text.includes("do NOT tell the user the app is live")
  );
}

export function completionHasFailureMarkerWithoutPositiveEvidence(
  text: string,
  verifiedUrls: readonly string[] = [],
): boolean {
  const body = userFacingCompletionBody(text);
  const fullText = stripRouterAnnotations(text);
  const searchable = [body, fullText].filter(Boolean).join("\n");
  if (verifiedUrls.length > 0 || hasUserFacingUrl(searchable)) return false;
  // An explicit tool-failure marker (exit code 1, "permission denied", …) means
  // the work failed regardless of any positive count the model also reported:
  // "tests failed, exit code 1, but I found 5 files" is still a failure. It must
  // be checked BEFORE the positive-evidence heuristic — that heuristic exists
  // only to keep a *successful* "found 5 results" from tripping the no-result
  // marker below, not to override a real failure. (Prior order let a positive
  // count mask an explicit failure and relay it to the user as success.)
  if (TOOL_FAILURE_MARKER_RE.test(searchable)) return true;
  if (POSITIVE_QUANTITATIVE_EVIDENCE_RE.test(searchable)) return false;
  return NO_RESULT_MARKER_RE.test(fullText) && !NO_RESULT_MARKER_RE.test(body);
}

function verifiedUrlsFromMetadata(message: Memory): string[] {
  return stringArrayOf(metadataRecord(message)?.subAgentVerifiedUrls);
}

function deliverableFromMetadata(message: Memory): string | undefined {
  const value = textOf(metadataRecord(message)?.subAgentDeliverable);
  return value.length > 0 ? value : undefined;
}

// A DEGENERATE completion is one the sub-agent's model could not finish cleanly:
// `length` (ran out of token / turn budget mid-answer — truncated) or
// `content_filter` (refused / blocked). The ACP `stopReason` is normalized to
// one of these by the router (subAgentFinishReason metadata) before it reaches
// here. Re-spawning the SAME root request on a degenerate completion just
// truncates/blocks again — the ~70x weak-model re-spawn loop (issue
// elizaOS/eliza#8875). We relay the best partial once instead.
const DEGENERATE_FINISH_REASONS = new Set(["length", "content_filter"]);

function finishReasonFromMetadata(message: Memory): string | undefined {
  const value = textOf(metadataRecord(message)?.subAgentFinishReason);
  return value.length > 0 ? value : undefined;
}

function isDegenerateFinishReason(reason: string | undefined): boolean {
  return reason !== undefined && DEGENERATE_FINISH_REASONS.has(reason);
}

// Longest completion body we treat as a bare "answer value" worth relaying over
// a planner re-spawn. Tight on purpose: a price / short sentence qualifies; a
// multi-line build report or transcript does not and keeps the existing
// step-aside-for-follow-up routing.
const SHORT_CLEAN_COMPLETION_BODY_MAX_CHARS = 120;

// Continuing the EXISTING session (TASKS_SEND_TO_AGENT / TASKS_SEND) is the only
// legitimate reason not to relay a completed task's short clean answer: the
// agent is feeding the same sub-agent more input (a real blocker/missing
// detail). Any other follow-up after a clean answer — a fresh spawn, a
// re-create, or no hint at all (the planner re-issued TASKS directly without
// populating candidateActions) — is a re-spawn loop, so relay instead.
const SESSION_CONTINUE_ACTIONS = new Set(["TASKS_SEND_TO_AGENT", "TASKS_SEND"]);

function isShortCleanCompletionBody(completionText: string): boolean {
  const body = userFacingCompletionBody(completionText).trim();
  if (!body || body.length > SHORT_CLEAN_COMPLETION_BODY_MAX_CHARS)
    return false;
  return !looksLikeRawToolTranscript(body);
}

function planContinuesExistingSession(plan: {
  candidateActions?: readonly string[];
  parentActionHints?: readonly string[];
}): boolean {
  const hints = [
    ...normalizedActionHints(plan.candidateActions),
    ...normalizedActionHints(plan.parentActionHints),
  ];
  return hints.some((hint) => SESSION_CONTINUE_ACTIONS.has(hint));
}

function isSuccessfulSubAgentCompletion(message: Memory): boolean {
  const content = contentRecord(message);
  const metadata = metadataRecord(message);
  if (!content || !metadata) return false;
  const source = textOf(content.source).toLowerCase();
  if (source !== SUB_AGENT_SOURCE && metadata.subAgent !== true) return false;
  if (textOf(metadata.subAgentEvent) !== "task_complete") return false;
  if (metadata.subAgentCapExceeded === true) return false;
  return !completionHasVerificationFailure(textOf(content.text));
}

function replyPatchFromCompletion(
  currentReply: string,
  completionText: string,
  verifiedUrls: readonly string[] = [],
  preferCurrentReplyForUrlOnlyCompletion = false,
) {
  const body = userFacingCompletionBody(completionText);
  const verifiedUrl = userFacingVerifiedUrl(verifiedUrls);
  const cleanBody = body && !looksLikeRawToolTranscript(body) ? body : "";
  const cleanCurrentReply = !looksLikeRawToolTranscript(currentReply)
    ? currentReply
    : "";
  if (!body && !verifiedUrl) return undefined;
  if (isEmptyCompletionPlaceholder(body)) return verifiedUrl;
  if (verifiedUrl && cleanCurrentReply && hasLoopbackUrl(cleanCurrentReply)) {
    const bodyWithoutLoopback =
      cleanBody && !bodyIsOnlyUrls(cleanBody) && hasLoopbackUrl(cleanBody)
        ? stripLoopbackUrlLines(cleanBody, verifiedUrl)
        : undefined;
    return (
      bodyWithoutLoopback ??
      stripLoopbackUrlLines(cleanCurrentReply, verifiedUrl)
    );
  }
  if (
    verifiedUrl &&
    cleanBody &&
    !bodyIsOnlyUrls(cleanBody) &&
    hasLoopbackUrl(cleanBody)
  ) {
    return stripLoopbackUrlLines(cleanBody, verifiedUrl);
  }
  if (
    verifiedUrl &&
    cleanCurrentReply &&
    !bodyIsOnlyUrls(cleanCurrentReply) &&
    replyMentionsVerifiedUrl(cleanCurrentReply, verifiedUrl)
  ) {
    return cleanCurrentReply;
  }
  if (
    verifiedUrl &&
    preferCurrentReplyForUrlOnlyCompletion &&
    cleanCurrentReply &&
    !hasUrl(cleanCurrentReply) &&
    bodyIsOnlyUrls(cleanBody)
  ) {
    return appendVerifiedUrl(cleanCurrentReply, verifiedUrl);
  }
  if (verifiedUrl && looksLikeRawToolTranscript(completionText)) {
    if (
      cleanBody &&
      !looksLikeCapturedToolOutput(cleanBody) &&
      !looksLikeRawToolTranscript(cleanBody) &&
      hasUserFacingUrl(cleanBody)
    ) {
      return cleanBody;
    }
    return verifiedUrl;
  }
  if (verifiedUrl && bodyIsOnlyUrls(cleanBody)) return verifiedUrl;
  if (
    cleanBody &&
    !looksLikeCapturedToolOutput(cleanBody) &&
    hasUserFacingUrl(cleanBody)
  ) {
    return cleanBody;
  }
  if (verifiedUrl) return verifiedUrl;
  if (hasUrl(cleanCurrentReply)) return cleanCurrentReply;
  if (cleanCurrentReply.length === 0) return cleanBody || body;
  if (!hasUrl(currentReply) && cleanBody && hasUrl(cleanBody)) return cleanBody;
  return cleanBody || body;
}

function hasVerifiedCompletionReply(
  currentReply: string,
  completionText: string,
  verifiedUrls: readonly string[] = [],
) {
  const body = userFacingCompletionBody(completionText);
  if (isEmptyCompletionPlaceholder(body)) {
    return (
      hasUrl(currentReply) || userFacingVerifiedUrl(verifiedUrls) !== undefined
    );
  }
  return (
    hasUrl(currentReply) ||
    hasUrl(body) ||
    userFacingVerifiedUrl(verifiedUrls) !== undefined
  );
}

// ---- verification-aware framing --------------------------------------------
//
// A sub-agent's `task_complete` arrives BEFORE the durable task has finished
// validation (the verifier runs fire-and-forget off the same event), so a
// relayed completion is a CLAIM, not a verified result. When the durable task
// record is reachable, the relay's framing must say so: `validating` gets a
// verification-pending note, and a task knocked back by a failed verification
// (re-engage in flight, or parked for a human after the attempt cap) gets a
// provisional note. Content heuristics above are untouched — only the framing
// changes. When no durable record backs the session (non-durable flows, tests
// without the service), behavior is exactly as before.

/** Matches OrchestratorTaskService.serviceType. String-referenced so this
 * planner-path module does not pull the whole task-service dependency tree. */
const ORCHESTRATOR_TASK_SERVICE_TYPE = "ORCHESTRATOR_TASK_SERVICE";

const VERIFICATION_PENDING_NOTE =
  "Note: independent verification of this result is still running — I'll flag it if anything fails.";
const VERIFICATION_REENGAGED_NOTE =
  "Note: verification found gaps in this result and the agent is being re-engaged to close them — treat the above as provisional.";

interface CompletionVerificationView {
  pendingVerification: boolean;
  verificationFailed: boolean;
  /** Worker-disclosed residual risks from the completion-time gate snapshot.
   * Disclosure is deliberately non-blocking (blocking it teaches workers to
   * delete the admission), so the user-facing relay is where it must surface. */
  disclosedRisks: string[];
}

interface TaskRecordLookup {
  getTaskForSession(sessionId: string): Promise<{
    status: string;
    metadata: Record<string, unknown>;
  } | null>;
}

async function verificationViewFor(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<CompletionVerificationView | undefined> {
  const sessionId = textOf(metadataRecord(message)?.subAgentSessionId);
  if (!sessionId) return undefined;
  try {
    if (typeof runtime?.getService !== "function") return undefined;
    const service = runtime.getService(
      ORCHESTRATOR_TASK_SERVICE_TYPE,
    ) as unknown as TaskRecordLookup | null;
    if (!service || typeof service.getTaskForSession !== "function") {
      return undefined;
    }
    const task = await service.getTaskForSession(sessionId);
    if (!task) return undefined;
    const attemptsRaw = task.metadata?.autoVerifyAttempts;
    const attempts =
      typeof attemptsRaw === "number" && Number.isFinite(attemptsRaw)
        ? attemptsRaw
        : 0;
    const snapshot = asRecord(task.metadata?.completionResiduals);
    const disclosedRisks = stringArrayOf(snapshot?.disclosedRisks);
    return {
      pendingVerification: task.status === "validating",
      // A `validating` task that fell back to `active` (re-engage) or parked
      // `waiting_on_user` with a non-zero attempt counter means verification
      // rejected the claim being relayed right now.
      verificationFailed:
        (task.status === "active" || task.status === "waiting_on_user") &&
        attempts > 0,
      disclosedRisks,
    };
  } catch {
    // error-policy:J4 the durable-task lookup is optional enrichment for
    // framing only; on failure the relay keeps its pre-verification behavior
    // (non-durable flows have no record to consult).
    return undefined;
  }
}

function frameReplyWithVerification(
  reply: string,
  view: CompletionVerificationView | undefined,
): string {
  if (!view) return reply;
  const notes: string[] = [];
  if (view.pendingVerification) notes.push(VERIFICATION_PENDING_NOTE);
  else if (view.verificationFailed) notes.push(VERIFICATION_REENGAGED_NOTE);
  if (view.disclosedRisks.length > 0) {
    notes.push(`Note: the worker flagged: ${view.disclosedRisks.join("; ")}.`);
  }
  return notes.length > 0 ? `${reply}\n\n${notes.join("\n")}` : reply;
}

function respondIfNeeded(messageHandler: MessageHandlerResult) {
  return messageHandler.processMessage === "RESPOND"
    ? {}
    : { processMessage: "RESPOND" as const };
}

export const subAgentCompletionResponseEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.sub-agent-completion",
  description:
    "Routes verified sub-agent task_complete messages to direct replies unless Stage 1 requested a concrete follow-up action.",
  priority: 10,
  shouldRun: ({ message, messageHandler }) => {
    if (!isSuccessfulSubAgentCompletion(message)) return false;
    if (messageHandler.processMessage === "STOP") return false;
    const currentReply = textOf(messageHandler.plan.reply);
    const completionText = textOf(contentRecord(message)?.text);
    const verifiedUrls = verifiedUrlsFromMetadata(message);
    if (
      completionHasFailureMarkerWithoutPositiveEvidence(
        completionText,
        verifiedUrls,
      )
    ) {
      return true;
    }
    if (deliverableFromMetadata(message) !== undefined) return true;
    if (hasVerifiedCompletionReply(currentReply, completionText, verifiedUrls))
      return true;
    if (hasCleanFinalProseAfterToolOutput(completionText)) return true;
    // A SHORT, CLEAN completion body IS the answer being looped on when the
    // planner's follow-up is anything but continuing the same session: some ACP
    // adapters (notably claude-agent-acp) return a one-shot lookup result as
    // bare final text — "$1,708.31", "Tokyo: +74°F" — never wrapped in a
    // [tool output:…] envelope, so it isn't captured as a deliverable and
    // matches none of the checks above. The planner then re-issues a fresh
    // TASKS spawn/create (sometimes without even populating candidateActions),
    // re-spawning the SAME lookup, looping and re-posting "working on it" acks
    // without relaying the value (observed live: claude 6 spawns / cerebras
    // weather 3 spawns). Relay unless the plan continues the EXISTING session
    // (TASKS_SEND_TO_AGENT — feeding a real blocker/missing detail back to the
    // running sub-agent), which is the one legitimate non-relay follow-up.
    // Bound the body tightly so multi-step coding completions keep the existing
    // routing.
    if (
      isShortCleanCompletionBody(completionText) &&
      !planContinuesExistingSession(messageHandler.plan)
    ) {
      return true;
    }
    // A truncated (`length`) or content-filtered (`content_filter`) sub-agent
    // completion is TERMINAL for the planner: the model ran out of room or was
    // blocked mid-answer, so a fresh TASKS_SPAWN_AGENT on the SAME root request
    // just truncates/blocks again — the ~70x weak-model re-spawn loop the cap
    // only bounds (issue elizaOS/eliza#8875). The ACP completion's stopReason is
    // threaded here as subAgentFinishReason. Relay the best partial once, UNLESS
    // the plan is feeding the still-running session more input
    // (TASKS_SEND_TO_AGENT), which is the one legitimate non-relay follow-up.
    if (
      isDegenerateFinishReason(finishReasonFromMetadata(message)) &&
      !planContinuesExistingSession(messageHandler.plan)
    ) {
      return true;
    }
    const hasConcreteFollowUp =
      hasStrings(messageHandler.plan.candidateActions) &&
      !hasOnlyStaleCompletionHints(messageHandler.plan.candidateActions);
    const hasConcreteParentHint =
      hasStrings(messageHandler.plan.parentActionHints) &&
      !hasOnlyStaleCompletionHints(messageHandler.plan.parentActionHints);
    if (hasConcreteFollowUp || hasConcreteParentHint) return false;
    return true;
  },
  evaluate: async ({ runtime, message, messageHandler }) => {
    const currentReply = textOf(messageHandler.plan.reply);
    const completionText = textOf(contentRecord(message)?.text);
    const verifiedUrls = verifiedUrlsFromMetadata(message);
    // Durable-task verification state, when the session has a record. Every
    // branch below that relays the completion as a user-facing reply frames it
    // through this view so an unverified claim is never presented as final.
    const verification = await verificationViewFor(runtime, message);
    // The deliverable IS the sub-agent's printed/tool output (short, single
    // block; the router stripped it from the narration). Relay it verbatim
    // rather than letting the parent model re-summarize or truncate it.
    const deliverable = deliverableFromMetadata(message);
    if (deliverable !== undefined) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: frameReplyWithVerification(deliverable, verification),
        debug: [
          "verified sub-agent completion carries a captured deliverable; relaying it verbatim",
        ],
      };
    }
    // Degenerate completion (truncated / content-filtered): relay the best
    // partial ONCE and clear the planner's candidate actions so it cannot
    // re-spawn the same request. When there is nothing usable to relay, suppress
    // the turn rather than loop (issue elizaOS/eliza#8875).
    const finishReason = finishReasonFromMetadata(message);
    if (
      isDegenerateFinishReason(finishReason) &&
      !planContinuesExistingSession(messageHandler.plan)
    ) {
      const partial = cleanCompletionReply(
        replyPatchFromCompletion(currentReply, completionText, verifiedUrls),
      );
      if (partial) {
        return {
          ...respondIfNeeded(messageHandler),
          requiresTool: false,
          setContexts: [SIMPLE_CONTEXT_ID],
          clearCandidateActions: true,
          clearParentActionHints: true,
          reply: frameReplyWithVerification(partial, verification),
          debug: [
            `sub-agent completion finished with stopReason=${finishReason} (truncated/blocked); relaying best partial once instead of re-spawning the same request`,
          ],
        };
      }
      return {
        processMessage: "IGNORE",
        requiresTool: false,
        clearReply: true,
        clearCandidateActions: true,
        clearParentActionHints: true,
        debug: [
          `sub-agent completion finished with stopReason=${finishReason} and carried no usable partial; suppressing to avoid a re-spawn loop`,
        ],
      };
    }
    if (
      completionHasFailureMarkerWithoutPositiveEvidence(
        completionText,
        verifiedUrls,
      )
    ) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: true,
        setContexts: [ORCHESTRATOR_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "sub-agent completion contains failure markers without clear positive evidence; routing back through TASKS for grounded follow-up",
        ],
      };
    }
    const reply = cleanCompletionReply(
      replyPatchFromCompletion(
        currentReply,
        completionText,
        verifiedUrls,
        messageHandler.plan.requiresTool === false &&
          !hasStrings(messageHandler.plan.candidateActions) &&
          !hasStrings(messageHandler.plan.parentActionHints),
      ),
    );
    if (
      isEmptyCompletionPlaceholder(userFacingCompletionBody(completionText))
    ) {
      if (!reply && !hasUrl(currentReply)) {
        return {
          processMessage: "IGNORE",
          requiresTool: false,
          clearReply: true,
          clearCandidateActions: true,
          clearParentActionHints: true,
          debug: [
            "verified sub-agent completion had no captured output; suppressing empty reply",
          ],
        };
      }
    }
    if (reply && hasUrl(reply)) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: frameReplyWithVerification(reply, verification),
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      };
    }
    const completionBody = stripRouterAnnotations(completionText);
    if (looksLikeCapturedToolOutput(completionBody)) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: true,
        setContexts: [ORCHESTRATOR_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "verified sub-agent completion only contains captured tool output; routing back through TASKS for follow-up",
        ],
      };
    }
    // Prose-and-tool-output mixed: looksLikeCapturedToolOutput requires the
    // body to start with `[tool output:` but real sub-agents intersperse
    // tool blocks with prose ("Site located at X. Now reading...
    // [tool output: ...] ..."). Check `looksLikeRawToolTranscript` against
    // the user-facing body (tool output blocks stripped) — if that still
    // contains raw transcript markers (e.g. "Full output saved to:" line
    // or an absolute path leak outside any tool block), route through
    // TASKS_SEND_TO_AGENT for a clean summary. When the stripped body is
    // clean prose, the final block of the previous `if` falls through to
    // the direct-reply branch below.
    const userFacingBody = userFacingCompletionBody(completionText);
    if (looksLikeRawToolTranscript(userFacingBody)) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: true,
        setContexts: [ORCHESTRATOR_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "verified sub-agent completion contains raw tool transcript markers; routing back through TASKS for summarization",
        ],
      };
    }
    const framedReply = reply
      ? frameReplyWithVerification(reply, verification)
      : reply;
    return {
      ...respondIfNeeded(messageHandler),
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      ...(framedReply ? { reply: framedReply } : {}),
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    };
  },
};
