/** Carries typed design validation, eligibility, provider, and transport failures. */

import { ElizaError } from "@elizaos/core";

export type DesignErrorCode =
  | "DESIGN_INVALID_INPUT"
  | "DESIGN_NOT_CONNECTED"
  | "DESIGN_UNSUPPORTED"
  | "DESIGN_MANAGED_MODE_INELIGIBLE"
  | "DESIGN_PLAN_LIMITED"
  | "DESIGN_AUTH_EXPIRED"
  | "DESIGN_AUTH_REVOKED"
  | "DESIGN_RATE_LIMITED"
  | "DESIGN_PROVIDER_REJECTED"
  | "DESIGN_PROVIDER_FAILURE"
  | "DESIGN_PROVIDER_TIMEOUT"
  | "DESIGN_PROVIDER_NETWORK"
  | "DESIGN_ENDPOINT_BLOCKED"
  | "DESIGN_RESPONSE_TOO_LARGE"
  | "DESIGN_MALFORMED_RESPONSE"
  | "DESIGN_EXPORT_FAILED";

export class DesignError extends ElizaError {
  override readonly name = "DesignError";
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      code: DesignErrorCode;
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
        options.code === "DESIGN_RATE_LIMITED" ||
        options.code === "DESIGN_PROVIDER_TIMEOUT" ||
        options.code === "DESIGN_PROVIDER_NETWORK" ||
        options.code === "DESIGN_PROVIDER_FAILURE"
          ? "ephemeral"
          : "fatal",
    });
    this.retryAfterMs = options.retryAfterMs;
  }
}
