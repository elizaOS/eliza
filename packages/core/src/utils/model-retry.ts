/**
 * Provider retry metadata shared by transport retries and durable memory jobs.
 * Only structural status/header fields establish a deadline; prose never does.
 *
 * The installed AI SDK wraps a provider failure in a `RetryError` envelope once
 * its own retries exhaust; the envelope's top node carries no status and no
 * headers — the 429 and its Retry-After live on the wrapped `APICallError`.
 * These classifiers therefore read the same bounded cause/lastError/errors
 * graph as the model-error classifiers, and never a message substring.
 */

/**
 * Bounded walk of the wrapped provider-error graph: `.cause`, the AI SDK
 * `RetryError` envelope's `.lastError` / `.errors[]`. Only object nodes are
 * traversed, bounded like the model-error chain walk.
 */
function* retryEvidenceNodes(error: unknown): Generator<object> {
	const seen = new Set<unknown>();
	const stack: unknown[] = [error];
	while (stack.length > 0 && seen.size < 12) {
		const node = stack.pop();
		if (typeof node !== "object" || node === null || seen.has(node)) continue;
		seen.add(node);
		yield node;
		const wrapped = node as {
			cause?: unknown;
			lastError?: unknown;
			errors?: unknown;
		};
		// Bound expansion as well as traversal: spreading an untrusted history
		// can overflow the call stack before the node limit applies. Prefer the
		// explicit final error, then cause, then recent retry history.
		const children: unknown[] = [wrapped.lastError, wrapped.cause];
		if (Array.isArray(wrapped.errors)) {
			for (
				let i = wrapped.errors.length - 1;
				i >= 0 && children.length < 12;
				i--
			) {
				children.push(wrapped.errors[i]);
			}
		}
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (typeof child === "object" && child !== null && !seen.has(child)) {
				stack.push(child);
			}
		}
	}
}

/**
 * Read the provider's retry delay once for both retry admission and cooldowns.
 * The millisecond header takes precedence over Retry-After seconds/date, matching
 * the SDK transport contract. Invalid values fall through to the other header;
 * missing or invalid hints leave the bounded exponential policy in control.
 */
export function providerRetryAfterMs(
	error: unknown,
	now = Date.now(),
): number | undefined {
	const headers = (error as { responseHeaders?: unknown } | undefined)
		?.responseHeaders;
	if (!headers || typeof headers !== "object") return undefined;
	let milliseconds: string | undefined;
	let secondsOrDate: string | undefined;
	for (const [key, value] of Object.entries(
		headers as Record<string, unknown>,
	)) {
		const raw = Array.isArray(value) ? value[0] : value;
		if (typeof raw !== "string" || raw.trim().length === 0) continue;
		if (key.toLowerCase() === "retry-after-ms") milliseconds = raw.trim();
		if (key.toLowerCase() === "retry-after") secondsOrDate = raw.trim();
	}
	const explicitMilliseconds =
		milliseconds === undefined ? Number.NaN : Number(milliseconds);
	if (Number.isFinite(explicitMilliseconds) && explicitMilliseconds >= 0)
		return explicitMilliseconds;
	if (secondsOrDate === undefined) return undefined;
	const seconds = Number(secondsOrDate);
	if (Number.isFinite(seconds))
		return seconds >= 0 && Number.isFinite(seconds * 1000)
			? seconds * 1000
			: undefined;
	const at = Date.parse(secondsOrDate);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Structural provider HTTP status from one error node, if any. */
function nodeStatus(node: object): number | undefined {
	const raw = (node as { statusCode?: unknown; status?: unknown }).statusCode;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const status = (node as { status?: unknown }).status;
	if (typeof status === "number" && Number.isFinite(status)) return status;
	return undefined;
}

/**
 * Explicit credit exhaustion is not a temporary rate-limit window. Any node in
 * the wrapped provider-error graph may carry the provider's quota codes.
 */
export function isPermanentQuotaError(error: unknown): boolean {
	const codes = new Set(["insufficient_quota", "credit_balance_exhausted"]);
	const inspect = (value: unknown): boolean => {
		if (typeof value !== "object" || value === null) return false;
		const record = value as Record<string, unknown>;
		return (
			(typeof record.code === "string" && codes.has(record.code)) ||
			(typeof record.type === "string" && codes.has(record.type)) ||
			(typeof record.error === "object" &&
				record.error !== null &&
				["code", "type"].some((key) => {
					const field = (record.error as Record<string, unknown>)[key];
					return typeof field === "string" && codes.has(field);
				}))
		);
	};
	for (const node of retryEvidenceNodes(error)) {
		const record = node as Record<string, unknown>;
		if (inspect(record) || inspect(record.data)) return true;
		if (typeof record.responseBody !== "string") continue;
		try {
			if (inspect(JSON.parse(record.responseBody))) return true;
		} catch {
			// error-policy:J3 malformed provider bodies cannot establish permanent quota exhaustion.
		}
	}
	return false;
}

/**
 * Absolute deadline survives evaluator processing before task persistence.
 * The 429 and its retry hint may sit on any node of the wrapped provider-error
 * graph; permanent quota exhaustion anywhere in the graph rejects the wait.
 */
export function providerRateLimitRetryAt(
	error: unknown,
	now = Date.now(),
): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (isPermanentQuotaError(error)) return undefined;
	for (const node of retryEvidenceNodes(error)) {
		if (nodeStatus(node) !== 429) continue;
		const explicit = (node as { retryAfterMs?: unknown }).retryAfterMs;
		const delay =
			typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0
				? explicit
				: providerRetryAfterMs(node, now);
		const deadline = delay === undefined ? Number.NaN : now + delay;
		if (Number.isFinite(deadline) && deadline > now) return deadline;
	}
	return undefined;
}

/** Provider rate-limit buckets a typed 429 may name. */
export const PROVIDER_RATE_LIMIT_SCOPES = ["burst", "sustained"] as const;
export type ProviderRateLimitScope =
	(typeof PROVIDER_RATE_LIMIT_SCOPES)[number];

/**
 * Typed, client-safe view of a provider 429. It holds only bounded fields:
 * never the provider message, the raw body or any credential.
 */
export interface ProviderRateLimit {
	kind: "rate_limited";
	/** Wait before the next attempt, whole milliseconds, capped. */
	retryAfterMs: number;
	/** Provider plan id that owns the refused bucket. */
	planId?: string;
	/** Provider bucket that refused the request. */
	scope?: ProviderRateLimitScope;
}

/** Upper bound for a reported wait; longer provider hints are clamped. */
export const MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS = 60 * 60 * 1000;

const PROVIDER_PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Clamp a provider wait to whole milliseconds; reject non-finite or negative. */
export function boundProviderRetryAfterMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return undefined;
	return Math.min(Math.ceil(value), MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS);
}

/**
 * Validate a rate-limit record at a trust boundary. Unknown keys are dropped,
 * a malformed plan id or scope is omitted, and the wait is capped.
 */
export function parseProviderRateLimit(
	value: unknown,
): ProviderRateLimit | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== "rate_limited") return undefined;
	const retryAfterMs = boundProviderRetryAfterMs(record.retryAfterMs);
	if (retryAfterMs === undefined) return undefined;
	const planId =
		typeof record.planId === "string" &&
		PROVIDER_PLAN_ID_PATTERN.test(record.planId)
			? record.planId
			: undefined;
	const scope = PROVIDER_RATE_LIMIT_SCOPES.find(
		(candidate) => candidate === record.scope,
	);
	return {
		kind: "rate_limited",
		retryAfterMs,
		...(planId ? { planId } : {}),
		...(scope ? { scope } : {}),
	};
}

/**
 * Read the typed rate limit a provider attached to its 429 (`rateLimit` on the
 * error node), through SDK and failover wrappers. Prose is never parsed. It is
 * a report for the client, not a retry signal: no caller waits on it.
 */
export function readProviderRateLimit(
	error: unknown,
): ProviderRateLimit | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (isPermanentQuotaError(error)) return undefined;
	for (const node of retryEvidenceNodes(error)) {
		if (nodeStatus(node) !== 429) continue;
		const rateLimit = parseProviderRateLimit(
			(node as { rateLimit?: unknown }).rateLimit,
		);
		if (rateLimit) return rateLimit;
	}
	return undefined;
}
