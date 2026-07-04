/**
 * Classifies model-call failures — rate-limit/429, auth 401/403, and transient
 * provider errors worth failing over to another provider — and assembles the
 * user-facing fallback reply when a turn's grounding trajectory fails.
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
