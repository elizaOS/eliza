/**
 * Typed failure taxonomy of the managed-provider HTTP client. The Cloud Maps
 * adapter wraps these into `MapsError` (preserving `cause` and `retryAfterMs`)
 * so callers branch on stable codes instead of transport strings.
 */

import { ElizaError } from "@elizaos/core";

export const MANAGED_PROVIDER_ERROR_CODES = [
  "INVALID_INPUT",
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
