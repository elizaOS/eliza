/**
 * Typed failure taxonomy shared by every managed-provider adapter. Adapters and
 * domain plugins wrap these into their own `ElizaError` subclasses (preserving
 * `cause` and `retryAfterMs`) so callers branch on stable codes instead of
 * transport strings, and policy layers can map failures onto the capability
 * execution-outcome contract without inspecting provider payloads.
 */

import { ElizaError } from "../../errors";
import type { CapabilityExecutionErrorCode } from "../../types/provider-integrations";

export const MANAGED_PROVIDER_ERROR_CODES = [
	"INVALID_INPUT",
	"CONNECTION_UNAVAILABLE",
	"AUTH_EXPIRED",
	"AUTH_REVOKED",
	"RATE_LIMITED",
	"PROVIDER_REJECTED",
	"PROVIDER_FAILURE",
	"PROVIDER_TIMEOUT",
	"PROVIDER_NETWORK",
	"ENDPOINT_BLOCKED",
	"RESPONSE_TOO_LARGE",
	"MALFORMED_RESPONSE",
	"PAGINATION_OVERFLOW",
] as const;
export type ManagedProviderErrorCode =
	(typeof MANAGED_PROVIDER_ERROR_CODES)[number];

const EPHEMERAL_CODES: ReadonlySet<ManagedProviderErrorCode> = new Set([
	"RATE_LIMITED",
	"PROVIDER_TIMEOUT",
	"PROVIDER_NETWORK",
	"PROVIDER_FAILURE",
]);

export class ManagedProviderError extends ElizaError {
	override readonly name = "ManagedProviderError";
	override readonly code: ManagedProviderErrorCode;
	/** Provider-declared retry delay for RATE_LIMITED responses, when parseable. */
	readonly retryAfterMs?: number;

	constructor(
		message: string,
		options: {
			code: ManagedProviderErrorCode;
			retryAfterMs?: number;
			cause?: unknown;
			context?: Record<string, unknown>;
		},
	) {
		super(message, {
			code: options.code,
			cause: options.cause,
			context: options.context,
			severity: EPHEMERAL_CODES.has(options.code) ? "ephemeral" : "fatal",
		});
		this.code = options.code;
		this.retryAfterMs = options.retryAfterMs;
	}
}

export function isManagedProviderError(
	value: unknown,
): value is ManagedProviderError {
	return value instanceof ManagedProviderError;
}

/**
 * Maps the adapter failure taxonomy onto the capability execution-error
 * contract consumed by policy decisions and receipts.
 */
export function toCapabilityExecutionErrorCode(
	code: ManagedProviderErrorCode,
): CapabilityExecutionErrorCode {
	switch (code) {
		case "INVALID_INPUT":
			return "invalid_request";
		case "AUTH_EXPIRED":
		case "AUTH_REVOKED":
			return "authentication_failed";
		case "RATE_LIMITED":
			return "rate_limited";
		case "PROVIDER_TIMEOUT":
			return "timeout";
		case "MALFORMED_RESPONSE":
			return "schema_drift";
		case "PROVIDER_REJECTED":
		case "PROVIDER_FAILURE":
		case "PROVIDER_NETWORK":
		case "RESPONSE_TOO_LARGE":
			return "provider_error";
		case "CONNECTION_UNAVAILABLE":
		case "ENDPOINT_BLOCKED":
		case "PAGINATION_OVERFLOW":
			return "unknown_error";
	}
}
