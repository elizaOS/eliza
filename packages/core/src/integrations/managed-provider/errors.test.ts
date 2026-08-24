/**
 * Exercises the managed-provider failure taxonomy against the real error
 * classes: field preservation on `ManagedProviderError` (code, context,
 * retryAfterMs, native cause chain), the transient-vs-fatal severity
 * classification over the complete code list, the instance-narrowing helper's
 * discrimination against the base `ElizaError`, and the exhaustive mapping onto
 * the capability execution-outcome codes. Fully deterministic — no network,
 * runtime, or clock involved.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import {
	isManagedProviderError,
	MANAGED_PROVIDER_ERROR_CODES,
	ManagedProviderError,
	toCapabilityExecutionErrorCode,
} from "./errors";

/** Codes whose failures are expected to be transient and retryable. */
const EPHEMERAL_CODES = [
	"RATE_LIMITED",
	"PROVIDER_TIMEOUT",
	"PROVIDER_NETWORK",
	"PROVIDER_FAILURE",
] as const;

describe("ManagedProviderError", () => {
	it("carries name, message, code, context, retryAfterMs, and the native cause", () => {
		const cause = new Error("token refresh failed");
		const error = new ManagedProviderError("The provider rejected the call.", {
			code: "AUTH_EXPIRED",
			context: { providerId: "linear", attempt: 2 },
			retryAfterMs: 4_000,
			cause,
		});

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toBeInstanceOf(ElizaError);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ManagedProviderError");
		expect(error.message).toBe("The provider rejected the call.");
		expect(error.code).toBe("AUTH_EXPIRED");
		expect(error.context).toEqual({ providerId: "linear", attempt: 2 });
		expect(error.retryAfterMs).toBe(4_000);
		expect(error.cause).toBe(cause);
	});

	it("classifies exactly the transient codes as ephemeral and everything else as fatal", () => {
		for (const code of MANAGED_PROVIDER_ERROR_CODES) {
			const error = new ManagedProviderError(`probe ${code}`, { code });
			if ((EPHEMERAL_CODES as readonly string[]).includes(code)) {
				expect(error.severity).toBe("ephemeral");
			} else {
				expect(error.severity).toBe("fatal");
			}
		}
	});

	it("leaves retryAfterMs undefined when the provider declares none", () => {
		const error = new ManagedProviderError("The provider was rate limited.", {
			code: "RATE_LIMITED",
		});

		expect(error.retryAfterMs).toBeUndefined();
	});
});

describe("isManagedProviderError", () => {
	it("accepts ManagedProviderError instances", () => {
		const error = new ManagedProviderError("boom", {
			code: "PROVIDER_FAILURE",
		});

		expect(isManagedProviderError(error)).toBe(true);
	});

	it("rejects the base ElizaError, plain errors, and non-errors", () => {
		const baseElizaError = new ElizaError("boom", { code: "UNCLASSIFIED" });
		const plainError = new Error("boom");

		expect(isManagedProviderError(baseElizaError)).toBe(false);
		expect(isManagedProviderError(plainError)).toBe(false);
		expect(isManagedProviderError(null)).toBe(false);
		expect(isManagedProviderError(undefined)).toBe(false);
		expect(isManagedProviderError("PROVIDER_TIMEOUT")).toBe(false);
		expect(isManagedProviderError({ code: "PROVIDER_TIMEOUT" })).toBe(false);
	});
});

describe("toCapabilityExecutionErrorCode", () => {
	it("maps every managed-provider code onto its capability execution outcome", () => {
		const expectedByCode: Record<string, string> = {
			INVALID_INPUT: "invalid_request",
			AUTH_EXPIRED: "authentication_failed",
			AUTH_REVOKED: "authentication_failed",
			RATE_LIMITED: "rate_limited",
			PROVIDER_TIMEOUT: "timeout",
			MALFORMED_RESPONSE: "schema_drift",
			PROVIDER_REJECTED: "provider_error",
			PROVIDER_FAILURE: "provider_error",
			PROVIDER_NETWORK: "provider_error",
			RESPONSE_TOO_LARGE: "provider_error",
			CONNECTION_UNAVAILABLE: "unknown_error",
			ENDPOINT_BLOCKED: "unknown_error",
			PAGINATION_OVERFLOW: "unknown_error",
		};

		for (const code of MANAGED_PROVIDER_ERROR_CODES) {
			expect(Object.hasOwn(expectedByCode, code)).toBe(true);
			expect(toCapabilityExecutionErrorCode(code)).toBe(expectedByCode[code]);
		}
		expect(Object.keys(expectedByCode).sort()).toEqual(
			[...MANAGED_PROVIDER_ERROR_CODES].sort(),
		);
	});

	it("maps auth expiry and revocation onto the same authentication outcome", () => {
		expect(toCapabilityExecutionErrorCode("AUTH_EXPIRED")).toBe(
			toCapabilityExecutionErrorCode("AUTH_REVOKED"),
		);
	});
});
