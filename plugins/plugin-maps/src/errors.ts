/** Carries typed maps validation, provider, authentication, and retry failures. */

import { ElizaError } from "@elizaos/core";

export type MapsErrorCode =
  | "MAPS_INVALID_INPUT"
  | "MAPS_PROVIDER_UNAVAILABLE"
  | "MAPS_NOT_FOUND"
  | "MAPS_AUTH_EXPIRED"
  | "MAPS_AUTH_REVOKED"
  | "MAPS_RATE_LIMITED"
  | "MAPS_PROVIDER_REJECTED"
  | "MAPS_PROVIDER_FAILURE"
  | "MAPS_PROVIDER_TIMEOUT"
  | "MAPS_PROVIDER_NETWORK"
  | "MAPS_ENDPOINT_BLOCKED"
  | "MAPS_RESPONSE_TOO_LARGE"
  | "MAPS_MALFORMED_RESPONSE"
  | "MAPS_STORAGE_FAILURE";

export class MapsError extends ElizaError {
  override readonly name = "MapsError";
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      code: MapsErrorCode;
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
        options.code === "MAPS_RATE_LIMITED" ||
        options.code === "MAPS_PROVIDER_TIMEOUT" ||
        options.code === "MAPS_PROVIDER_NETWORK" ||
        options.code === "MAPS_PROVIDER_FAILURE"
          ? "ephemeral"
          : "fatal",
    });
    this.retryAfterMs = options.retryAfterMs;
  }
}
