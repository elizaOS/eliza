/** Carries typed Linear validation, credential, provider, and retry failures. */

import { ElizaError } from "@elizaos/core";

export type LinearErrorCode =
  | "LINEAR_INVALID_INPUT"
  | "LINEAR_NOT_CONFIGURED"
  | "LINEAR_UNAVAILABLE"
  | "LINEAR_NOT_FOUND"
  | "LINEAR_AUTH_EXPIRED"
  | "LINEAR_AUTH_REVOKED"
  | "LINEAR_RATE_LIMITED"
  | "LINEAR_PROVIDER_REJECTED"
  | "LINEAR_PROVIDER_FAILURE"
  | "LINEAR_PROVIDER_TIMEOUT"
  | "LINEAR_PROVIDER_NETWORK"
  | "LINEAR_ENDPOINT_BLOCKED"
  | "LINEAR_RESPONSE_TOO_LARGE"
  | "LINEAR_MALFORMED_RESPONSE";

export class LinearError extends ElizaError {
  override readonly name = "LinearError";
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      code: LinearErrorCode;
      retryAfterMs?: number;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: options.code,
      cause: options.cause,
      context: options.context,
      severity:
        options.code === "LINEAR_RATE_LIMITED" ||
        options.code === "LINEAR_PROVIDER_TIMEOUT" ||
        options.code === "LINEAR_PROVIDER_NETWORK" ||
        options.code === "LINEAR_PROVIDER_FAILURE"
          ? "ephemeral"
          : "fatal",
    });
    this.retryAfterMs = options.retryAfterMs;
  }
}
