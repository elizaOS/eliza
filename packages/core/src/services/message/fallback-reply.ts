/**
 * Classifies model-call failures — rate-limit/429, credit exhaustion/402,
 * auth 401/403, and transient provider errors worth failing over to another
 * provider — and assembles the user-facing fallback reply when a turn's
 * grounding trajectory fails.
 * Classification unwraps the AI SDK retry envelope and reads the structured HTTP
 * status first, falling back to a message-substring scan for status-less errors.
 * buildFailureReplyPrompt shapes the in-character apology (never answering on the
 * merits), and stripReasoningBlocks removes <think> spans from the raw reply.
 */
import { ModelType } from "../../types/model";

type ErrorWithStatus = {
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
 * The user-facing reply for a credit-exhausted provider. One string for every
 * delivery path: the direct chat API (`packages/agent` re-uses it) and the
 * connector failure-reply path below, so a Discord/Telegram user and a
 * dashboard user read the same actionable condition. Characters override via
 * `character.templates.insufficientCreditsReply`.
 */
export const INSUFFICIENT_CREDITS_REPLY =
	"Eliza Cloud credits are depleted. Top up the cloud balance and try again.";

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

export function buildFailureReplyPrompt(recentMessages: string): string {
	return [
		"You hit a transient model error and have to send a short user-facing reply.",
		"Write a one or two sentence reply in plain language.",
		"",
		"Hard rules:",
		"- Stay in character. Keep your usual voice and tone.",
		"- NEVER answer the user's question on the merits.",
		"- The trajectory that would have GROUNDED the answer failed, so do not emit answer-shaped tokens from memory or context.",
		"- Do not provide a SHA, a count, a price, a date, a status, a file path, or a name as if it were verified.",
		"- Acknowledge that something went wrong and suggest a retry.",
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
