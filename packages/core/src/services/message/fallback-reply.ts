/**
 * Classifies model-call failures — rate-limit/429, credit exhaustion/402,
 * auth 401/403, and transient provider errors worth failing over to another
 * provider — and assembles the user-facing fallback reply when a turn's
 * grounding trajectory fails.
 * Classification unwraps the AI SDK retry envelope and reads the structured HTTP
 * status first, falling back to a message-substring scan for status-less errors.
 * buildFailureReplyPrompt shapes the in-character apology (never answering on the
 * merits), and stripReasoningBlocks removes <think> spans from the raw reply.
 * classifyTurnFailureCause additionally maps the error that terminated a turn
 * (trajectory exhaustion, missing capability, repeated handler failure,
 * persistence failure) to a TurnFailureCause so the fallback reply states the
 * specific failure and never reads as a completed request (#17027 AC6).
 */
import { ModelType } from "../../types/model";

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
function clampForScan(value: string): string {
	return value.length > 10_000 ? value.slice(0, 10_000) : value;
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
 * Structural cause of a failed turn, classified from the error that killed the
 * message runtime. Distinguishes the four terminal shapes issue #17027 AC6
 * requires to produce visibly different user-facing replies: the agent lacked
 * the capability, the planner ran out of budget, a step failed while
 * executing, or the result could not be persisted. `null` means the cause is
 * unclassified and the generic transient framing applies.
 */
export type TurnFailureCause =
	| "capability_unavailable"
	| "planner_exhausted"
	| "execution_failed"
	| "persistence_failed";

/**
 * Deterministic last-ditch reply per classified turn-failure cause, used when
 * every fallback model slot also failed. Each text states plainly that the
 * request was NOT completed and nothing was saved — a fabricated-success
 * guardrail, so never soften these into ambiguous acknowledgements.
 */
export const TURN_FAILURE_FALLBACK_REPLIES: Record<TurnFailureCause, string> = {
	capability_unavailable:
		"I can't do that here, I don't have the ability set up right now. Nothing was saved or changed.",
	planner_exhausted:
		"I ran out of room before finishing that, so I stopped without completing it. Nothing was saved or changed. Want me to try again?",
	execution_failed:
		"Something failed while I was working on that, so I stopped without completing it. Nothing was saved or changed. Please try again.",
	persistence_failed:
		"I couldn't save that, the change did not stick. Treat it as not done and please try again.",
};

function errorCode(error: unknown): string {
	const candidate = asErrorObject(error);
	return candidate && typeof candidate.code === "string" ? candidate.code : "";
}

/**
 * Maps the error that terminated a message-runtime turn to a
 * {@link TurnFailureCause}. Trajectory-limit exhaustion is matched by error
 * name (not instanceof) so wrapped or cross-realm errors still classify, and
 * its `kind` splits missing-capability shapes (the planner repeatedly reached
 * for tools that do not exist or never produced the required tool) from
 * repeated handler failures and plain budget exhaustion. Persistence failures
 * are recognized by the `*_PERSISTENCE_FAILED` ElizaError code convention.
 */
export function classifyTurnFailureCause(
	error: unknown,
): TurnFailureCause | null {
	if (error instanceof Error && error.name === "TrajectoryLimitExceeded") {
		const kind = (error as Error & { kind?: unknown }).kind;
		switch (kind) {
			case "required_tool_misses":
			case "unavailable_tool_calls":
				return "capability_unavailable";
			case "repeated_failures":
				return "execution_failed";
			default:
				return "planner_exhausted";
		}
	}
	const code = errorCode(error);
	if (code === "CAPABILITY_UNAVAILABLE") return "capability_unavailable";
	if (code.includes("PERSISTENCE_FAILED") || code.includes("PERSIST_FAILED")) {
		return "persistence_failed";
	}
	return null;
}

const TURN_FAILURE_PROMPT_FRAMING: Record<TurnFailureCause, string[]> = {
	capability_unavailable: [
		"You could not do what the user asked because you do not have that ability in this environment.",
		"Write a one or two sentence reply in plain language.",
		"",
		"Hard rules:",
		"- Say plainly that you can't do that here, and that nothing was set up, saved, or changed.",
	],
	planner_exhausted: [
		"You ran out of attempts before completing the user's request. The task was NOT completed and nothing was saved or changed.",
		"Write a one or two sentence reply in plain language.",
		"",
		"Hard rules:",
		"- Say plainly that the task was not completed and nothing was saved or changed.",
	],
	execution_failed: [
		"A step failed while carrying out the user's request. The task was NOT completed and nothing was saved or changed.",
		"Write a one or two sentence reply in plain language.",
		"",
		"Hard rules:",
		"- Say plainly that the task failed partway and nothing was saved or changed.",
	],
	persistence_failed: [
		"The user's request could not be saved. The change did not persist, so the task is NOT done.",
		"Write a one or two sentence reply in plain language.",
		"",
		"Hard rules:",
		"- Say plainly that the change could not be saved and the task is not done.",
	],
};

export function buildFailureReplyPrompt(
	recentMessages: string,
	cause?: TurnFailureCause | null,
): string {
	const framing = cause
		? TURN_FAILURE_PROMPT_FRAMING[cause]
		: [
				"You hit a transient model error and have to send a short user-facing reply.",
				"Write a one or two sentence reply in plain language.",
				"",
				"Hard rules:",
			];
	return [
		...framing,
		"- Stay in character. Keep your usual voice and tone.",
		"- NEVER answer the user's question on the merits.",
		"- The trajectory that would have GROUNDED the answer failed, so do not emit answer-shaped tokens from memory or context.",
		"- Do not provide a SHA, a count, a price, a date, a status, a file path, or a name as if it were verified.",
		"- NEVER claim anything was saved, scheduled, created, updated, or set up.",
		cause === "capability_unavailable"
			? "- Do not suggest retrying; retrying cannot succeed without the missing ability."
			: "- Acknowledge that something went wrong and suggest a retry.",
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

export function stripReasoningBlocks(raw: string): string {
	return raw
		.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
		.replace(/^[\s\S]*?<\/think>/i, "")
		.replace(/<think\b[^>]*>[\s\S]*$/gi, "")
		.replace(/\/?\bno_think\b/gi, "")
		.trim();
}
