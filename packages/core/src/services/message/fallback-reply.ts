/**
 * Classifies model-call failures — rate-limit/429, credit exhaustion/402,
 * auth 401/403, and transient provider errors worth failing over to another
 * provider — and assembles the user-facing fallback reply when a turn's
 * grounding trajectory fails.
 * Classification unwraps the AI SDK retry envelope and reads the structured HTTP
 * status first, falling back to a message-substring scan for status-less errors.
 * buildFailureReplyPrompt shapes the in-character apology (never answering on the
 * merits), and stripReasoningBlocks removes private-reasoning spans from the raw
 * reply.
 */
import { TrajectoryLimitExceeded } from "../../runtime/limits";
import { readActionFailureProvenance } from "../../types/action-failure";
import { ModelType } from "../../types/model";
import {
	findNextCloseTag,
	REASONING_TAG_NAMES,
	stripPairedTagBlocks,
	stripUnclosedTagSuffix,
} from "../../utils/reasoning-tags";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../utils/well-formed.ts";

type ErrorWithStatus = {
	code?: unknown;
	status?: unknown;
	statusCode?: unknown;
	lastError?: unknown;
	errors?: unknown;
	error?: unknown;
};

function asErrorObject(error: unknown): ErrorWithStatus | null {
	return typeof error === "object" && error !== null
		? (error as ErrorWithStatus)
		: null;
}

function unwrapRetryError(error: unknown): unknown {
	const candidate = asErrorObject(error);
	if (!candidate) return error;
	if (candidate.lastError) return candidate.lastError;
	if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
		return candidate.errors[candidate.errors.length - 1];
	}
	return error;
}

function hasHttpStatus(error: unknown, statuses: readonly number[]): boolean {
	const candidate = asErrorObject(error);
	if (!candidate) return false;
	return statuses.includes(Number(candidate.statusCode ?? candidate.status));
}

function readHttpStatus(error: unknown): number | undefined {
	const candidate = asErrorObject(error);
	if (!candidate) return undefined;
	const status = Number(candidate.statusCode ?? candidate.status);
	return Number.isFinite(status) && status > 0 ? status : undefined;
}

/**
 * Pull the most specific human-readable message off a thrown value: a real
 * `Error.message`, a raw string, or the nested provider body a bare object
 * carries (`{ error: { message } }`, `{ error: "..." }`, `{ message }`).
 * Returns undefined when nothing message-shaped is present so the caller can
 * fall back to status or a serialized payload rather than "[object Object]".
 */
function extractErrorMessage(error: unknown): string | undefined {
	if (error instanceof Error) {
		const message = error.message.trim();
		return message.length > 0 ? message : undefined;
	}
	if (typeof error === "string") {
		const message = error.trim();
		return message.length > 0 ? message : undefined;
	}
	const candidate = asErrorObject(error);
	if (!candidate) return undefined;
	const body = candidate.error;
	if (typeof body === "string" && body.trim().length > 0) {
		return body.trim();
	}
	if (body !== null && typeof body === "object") {
		const nested = (body as { message?: unknown }).message;
		if (typeof nested === "string" && nested.trim().length > 0) {
			return nested.trim();
		}
	}
	const topLevel = (candidate as { message?: unknown }).message;
	if (typeof topLevel === "string" && topLevel.trim().length > 0) {
		return topLevel.trim();
	}
	return undefined;
}

/**
 * Render any thrown model-call failure as one diagnostic line — the HTTP
 * status (unwrapped from the AI SDK retry envelope) plus the most specific
 * message found on the error or its structured body. Providers throw a mix of
 * `Error` instances and bare `{ status, error }` objects; a bare object
 * stringifies to the useless "[object Object]", so the model-failover rethrow
 * routes non-trivial values through here to keep logs, trajectories, and any
 * user-surfaced failure text diagnostic. Never returns "[object Object]": when
 * no status or message is recoverable it serializes the payload instead.
 */
export function describeModelCallError(error: unknown): string {
	const unwrapped = unwrapRetryError(error);
	const status = readHttpStatus(unwrapped) ?? readHttpStatus(error);
	const message = extractErrorMessage(unwrapped) ?? extractErrorMessage(error);
	if (message && status) return `HTTP ${status}: ${message}`;
	if (message) return message;
	if (status) return `HTTP ${status}`;
	try {
		const serialized = JSON.stringify(error);
		if (serialized && serialized !== "{}") return serialized;
	} catch {
		// error-policy:J3 a non-serializable payload (circular ref, BigInt) still
		// must not surface as "[object Object]" — fall through to String().
	}
	return String(error);
}

/**
 * Detect provider rate-limit / 429 failures so the user-facing failure reply
 * can say "I'm being rate-limited, try again shortly" instead of the opaque
 * generic "something went wrong".
 *
 * The structural check runs FIRST and is the canonical signal: the AI SDK
 * carries the upstream HTTP status on `APICallError.statusCode` (wrapped by
 * `RetryError` when retries are exhausted), so we unwrap the retry envelope and
 * read `statusCode === 429` directly — mirroring cloud-shared `aiSdkErrorStatus`.
 * The message substring scan is only a status-less fallback for errors that do
 * not surface a structured status (e.g. raw text), and the legacy `.status`
 * duck-type covers raw OpenAI-SDK errors that expose `.status` instead.
 */
export function isRateLimitError(error: unknown): boolean {
	const unwrapped = unwrapRetryError(error);
	if (hasHttpStatus(unwrapped, [429])) {
		return true;
	}
	if (!(error instanceof Error)) return false;
	const haystack = `${error.name} ${error.message}`.toLowerCase();
	return (
		haystack.includes("too many requests") ||
		haystack.includes("rate limit") ||
		haystack.includes("rate_limit") ||
		haystack.includes("ratelimit") ||
		haystack.includes("requests per minute") ||
		haystack.includes("requests per second") ||
		haystack.includes("requests per hour") ||
		haystack.includes("slow down") ||
		haystack.includes("overloaded") ||
		// Subscription-credit exhaustion (Claude/Codex CLI-SDK brains): the SDK
		// surfaces "you've hit your session/usage limit" when the monthly credit
		// runs dry. Treat it as a rate limit so the graceful "temporarily
		// unavailable" reply path handles it instead of leaking the raw string.
		haystack.includes("session limit") ||
		haystack.includes("usage limit") ||
		/\b429\b/.test(haystack) ||
		/\b529\b/.test(haystack)
	);
}

/**
 * The user-facing reply for a credit-exhausted provider. One provider-neutral
 * string serves every delivery path because the failure boundary does not
 * reliably know whether routing selected Eliza Cloud or a direct provider.
 * The direct chat API (`packages/agent` re-uses it) and connector failure-reply
 * path therefore report the same actionable condition without misattributing
 * billing ownership. Characters override via
 * `character.templates.insufficientCreditsReply`.
 */
export const INSUFFICIENT_CREDITS_REPLY =
	"The configured AI provider is out of credits or quota. Add credits or increase its quota, then try again.";

// Credits-specific phrases only — deliberately no plain rate-limit tokens
// (e.g. `rate_limit_exceeded`), so a transient throttle can never classify as
// "out of credits" and tell the user to spend money on a condition that
// resolves by waiting.
const INSUFFICIENT_CREDITS_RE =
	/\b(?:insufficient(?:[_\s]+(?:credits?|quota|funds))|insufficient_quota|out of credits|max usage reached|quota(?:\s+exceeded)?|billing.*disabled|payment.*required|account.*suspended|spending.*limit|budget.*exceeded|no.*api.*credits|credit.*balance.*zero)\b/i;

const BILLING_KEYWORDS_RE =
	/\b(?:billing|quota|credits?|budget|spending|payment|subscription|plan limit)\b/i;

/** Cap a value before running a regex scan so a pathological provider payload
 *  cannot turn a substring match into a catastrophic-backtracking DoS. */
export function clampForScan(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	return wellFormed.length > 10_000
		? truncateWellFormed(wellFormed, 10_000)
		: wellFormed;
}

export function isInsufficientCreditsMessage(message: string): boolean {
	return INSUFFICIENT_CREDITS_RE.test(clampForScan(message));
}

/**
 * Detect provider credit/quota exhaustion — HTTP 402, a structured
 * `insufficient_credits`/`insufficient_quota` error body, or a 429 that
 * carries billing context — so the user-facing failure reply can say "top up"
 * instead of suggesting a retry that can never succeed against a drained
 * balance. Mirrors {@link isRateLimitError}: the structural signal (status
 * after unwrapping the AI SDK retry envelope, then the provider error body)
 * runs first; the message-substring scan is only a status-less fallback.
 *
 * Callers MUST check this before {@link isRateLimitError}: a 429 *with*
 * billing context is credit exhaustion ("top up"), whereas a bare 429 is
 * "try again in a moment".
 */
export function isInsufficientCreditsError(error: unknown): boolean {
	if (typeof error === "string") return isInsufficientCreditsMessage(error);
	const unwrapped = unwrapRetryError(error);
	if (hasHttpStatus(unwrapped, [402])) {
		return true;
	}
	const candidate = asErrorObject(unwrapped);
	if (!candidate) return false;
	const errorBody =
		typeof candidate.error === "object" && candidate.error !== null
			? (candidate.error as { type?: unknown; code?: unknown })
			: null;
	if (errorBody?.type === "insufficient_quota") return true;
	if (
		typeof errorBody?.code === "string" &&
		isInsufficientCreditsMessage(errorBody.code)
	) {
		return true;
	}
	const message = unwrapped instanceof Error ? unwrapped.message : "";
	if (isInsufficientCreditsMessage(message)) return true;
	return (
		hasHttpStatus(unwrapped, [429]) &&
		BILLING_KEYWORDS_RE.test(clampForScan(message))
	);
}

/**
 * Detect provider auth failures (401/403 — invalid/expired/unauthorized API key)
 * so the user-facing failure reply can say "my cloud key isn't authorized — check
 * your Eliza Cloud key / add credits" instead of the opaque generic
 * "something went wrong". Mirrors {@link isRateLimitError}: structured HTTP status
 * first, message-substring fallback second.
 */
export function isAuthError(error: unknown): boolean {
	const unwrapped = unwrapRetryError(error);
	if (hasHttpStatus(unwrapped, [401, 403])) {
		return true;
	}
	if (!(error instanceof Error)) return false;
	const haystack = `${error.name} ${error.message}`.toLowerCase();
	return (
		haystack.includes("invalid or expired api key") ||
		haystack.includes("authentication_required") ||
		haystack.includes("authentication failed") ||
		haystack.includes("unauthorized") ||
		haystack.includes("not authorized") ||
		haystack.includes("invalid api key") ||
		haystack.includes("expired api key") ||
		/\b401\b/.test(haystack) ||
		/\b403\b/.test(haystack)
	);
}

/**
 * Detect failures where another model provider is worth trying before giving up.
 * This intentionally includes {@link isRateLimitError} so subscription-credit
 * exhaustion from CLI-SDK providers follows the same structural 429/session-limit
 * classifier as the graceful reply path.
 *
 * `modelType` gates the decision per slot. `TEXT_TO_SPEECH` never fails over:
 * a voice swap is not a transient-recoverable condition, and a Kokoro
 * model-download failure surfaces as `fetch failed`, which would otherwise match
 * the transient heuristics below and silently rotate to a different voice engine
 * (#12253). TTS fails closed — the configured voice errors loudly instead.
 */
export function isModelProviderFallbackError(
	error: unknown,
	modelType?: string,
): boolean {
	if (modelType === ModelType.TEXT_TO_SPEECH) {
		return false;
	}
	const unwrapped = unwrapRetryError(error);
	// Local inference can disappear after registration (model unload, device
	// disconnect, or an unavailable native binding). Its typed capability error
	// means another text provider may safely answer the same request.
	if (asErrorObject(unwrapped)?.code === "LOCAL_INFERENCE_UNAVAILABLE") {
		return true;
	}
	if (isRateLimitError(error)) {
		return true;
	}
	if (hasHttpStatus(unwrapped, [500, 502, 503, 504, 529])) {
		return true;
	}
	if (!(error instanceof Error)) return false;
	const haystack = `${error.name} ${error.message}`.toLowerCase();
	return (
		haystack.includes("timeout") ||
		haystack.includes("timed out") ||
		haystack.includes("temporarily unavailable") ||
		haystack.includes("service unavailable") ||
		haystack.includes("overloaded") ||
		haystack.includes("bad gateway") ||
		haystack.includes("gateway timeout") ||
		haystack.includes("internal server error") ||
		haystack.includes("econnreset") ||
		haystack.includes("socket hang up") ||
		haystack.includes("network error") ||
		haystack.includes("fetch failed") ||
		/\b529\b/.test(haystack)
	);
}

/**
 * Why the turn ended on the structured-failure path, classified from the
 * error that killed the runtime (#17027 AC6). Distinguishable causes get
 * distinguishable user-facing replies instead of one generic
 * "something flaked" template:
 *
 * - `missing_capability` — the planner requested a tool which was not
 *   registered or otherwise invocable in this runtime. Retrying cannot help;
 *   the honest reply names the gap.
 * - `planner_exhaustion` — the planner ran out of budget (tool calls,
 *   repeated failures, token budget) before finishing. Retrying may help.
 * - `transient` — a model/provider/infrastructure error; the pre-existing
 *   generic path.
 */
export type StructuredFailureCause =
	| "missing_capability"
	| "handler_error"
	| "persistence_error"
	| "planner_exhaustion"
	| "transient";

/**
 * Classify the error that aborted the message runtime into a
 * `StructuredFailureCause`. Trajectory-limit aborts are the only errors
 * that structurally identify their cause today. Only
 * `unavailable_tool_calls` proves a capability is absent. A
 * `required_tool_misses` limit can occur with a registered tool when the model
 * repeatedly emits no usable call, so it is planner exhaustion and retryable.
 * Everything else stays `transient`.
 */
export function classifyStructuredFailureCause(
	error: unknown,
): StructuredFailureCause {
	if (error instanceof TrajectoryLimitExceeded) {
		switch (error.kind) {
			case "required_tool_misses":
				return "planner_exhaustion";
			case "unavailable_tool_calls":
				return "missing_capability";
			case "repeated_failures":
				return error.failureProvenance?.kind ?? "planner_exhaustion";
			case "tool_calls":
			case "terminal_only_continuations":
			case "trajectory_token_budget":
				return "planner_exhaustion";
			default: {
				const exhaustive: never = error.kind;
				return exhaustive;
			}
		}
	}
	return readActionFailureProvenance(error)?.kind ?? "transient";
}

const FAILURE_PROMPT_CAUSE_LINES: Record<StructuredFailureCause, string[]> = {
	missing_capability: [
		"The user asked for something that needs a capability which is not available in this setup, so the request could not be carried out.",
		"Write a one or two sentence reply in plain language.",
	],
	handler_error: [
		"An action failed while carrying out the user's request, so the request was not completed.",
		"Write a one or two sentence reply in plain language.",
	],
	persistence_error: [
		"The requested change reached its persistence boundary but could not be saved, so it must not be described as completed.",
		"Write a one or two sentence reply in plain language.",
	],
	planner_exhaustion: [
		"You ran out of attempts while working on the user's request and could not finish it.",
		"Write a one or two sentence reply in plain language.",
	],
	transient: [
		"You hit a transient model error and have to send a short user-facing reply.",
		"Write a one or two sentence reply in plain language.",
	],
};

const FAILURE_PROMPT_CAUSE_RETRY_RULE: Record<StructuredFailureCause, string> =
	{
		missing_capability:
			"- Tell the user plainly that you are not able to do that here right now. Do NOT claim it was done, and do not promise to retry - retrying cannot succeed until the capability is enabled.",
		handler_error:
			"- Tell the user that the action failed and was not completed. Do not claim success; suggest a retry only if appropriate.",
		persistence_error:
			"- Tell the user that the change could not be saved and was not completed. Do not claim success; suggest a retry.",
		planner_exhaustion:
			"- Acknowledge that you could not finish the request and suggest a retry.",
		transient: "- Acknowledge that something went wrong and suggest a retry.",
	};

export function buildFailureReplyPrompt(
	recentMessages: string,
	cause: StructuredFailureCause = "transient",
): string {
	return [
		...FAILURE_PROMPT_CAUSE_LINES[cause],
		"",
		"Hard rules:",
		"- Stay in character. Keep your usual voice and tone.",
		"- NEVER answer the user's question on the merits.",
		"- The trajectory that would have GROUNDED the answer failed, so do not emit answer-shaped tokens from memory or context.",
		"- Do not provide a SHA, a count, a price, a date, a status, a file path, or a name as if it were verified.",
		FAILURE_PROMPT_CAUSE_RETRY_RULE[cause],
		"- Do not paraphrase or echo the user's question as if you are about to answer it.",
		"- NEVER mention internal mechanism words such as: planner, action_planner,",
		"  XML, JSON, schema, structured output, model, retries, sonnet,",
		"  opus, claude, anthropic, prompt, parse, parser, xml plan, decision",
		"  loop, runtime, dispatch, or hand off. The user does not know or care",
		"  what those are.",
		"- Do not use em-dashes or en-dashes. Use a plain hyphen, period, or comma.",
		"- Return only the reply text. No labels, no XML, no JSON, no <think>.",
		"",
		"Recent Conversation:",
		recentMessages,
		"",
		"Reply:",
	].join("\n");
}

const REASONING_TAG_ALTERNATION = REASONING_TAG_NAMES.join("|");

/**
 * Strips a leading close-only residue prefix — model output can open with a
 * dangling close tag left over from a previous stripping pass (e.g. the
 * evaluator's "None</think>" repair) with no matching open of its own. Only
 * the first remaining close matters here: everything before it is discarded,
 * everything at/after it is kept for the caller's later passes.
 */
function stripLeadingCloseOnlyResidue(text: string): string {
	const close = findNextCloseTag(text, 0, REASONING_TAG_ALTERNATION);
	return close ? text.slice(close.end) : text;
}

export function stripReasoningBlocks(raw: string): string {
	const paired = stripPairedTagBlocks(raw, REASONING_TAG_ALTERNATION);
	const afterLeadingClose = stripLeadingCloseOnlyResidue(paired);
	const afterUnclosedSuffix = stripUnclosedTagSuffix(
		afterLeadingClose,
		REASONING_TAG_ALTERNATION,
	);
	return afterUnclosedSuffix.replace(/\/?\bno_think\b/gi, "").trim();
}
