/** Owns gateway token acquisition, response validation and renewal timing across connector services. */

import { ElizaError } from "@elizaos/core";
import { boundedFetch } from "./bounded-fetch";

export interface GatewayTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}

export const GATEWAY_TOKEN_MAX_LIFETIME_SECONDS = 60;
export const GATEWAY_TOKEN_REQUEST_TIMEOUT_MS = 15_000;

const TOKEN_REFRESH_FRACTION = 0.5;
const TOKEN_REFRESH_RETRY_MIN_MS = 1_000;
const TOKEN_REFRESH_RETRY_MAX_MS = 8_000;

/** Rejects malformed token responses before they can corrupt gateway auth state. */
export function parseGatewayTokenResponse(
  value: unknown,
): GatewayTokenResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid gateway token response");
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.access_token !== "string" ||
    candidate.access_token.trim().length === 0 ||
    candidate.access_token !== candidate.access_token.trim() ||
    candidate.token_type !== "Bearer" ||
    typeof candidate.expires_in !== "number" ||
    !Number.isFinite(candidate.expires_in) ||
    candidate.expires_in <= 0 ||
    candidate.expires_in > GATEWAY_TOKEN_MAX_LIFETIME_SECONDS
  ) {
    throw new Error("Invalid gateway token response");
  }

  return {
    access_token: candidate.access_token,
    token_type: candidate.token_type,
    expires_in: candidate.expires_in,
  };
}

/** Refreshes halfway through the lease, leaving room for bounded retries. */
export function gatewayTokenRefreshDelayMs(expiresInSeconds: number): number {
  return expiresInSeconds * 1_000 * TOKEN_REFRESH_FRACTION;
}

/** Applies equal jitter so gateway replicas do not retry in lockstep. */
export function gatewayTokenRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponentialDelay = Math.min(
    TOKEN_REFRESH_RETRY_MIN_MS * 2 ** Math.max(0, attempt),
    TOKEN_REFRESH_RETRY_MAX_MS,
  );
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.floor(exponentialDelay / 2 + (exponentialDelay / 2) * jitter);
}

/** Exchanges gateway credentials with a deadline covering headers and the complete body. */
export async function requestGatewayToken(
  url: string,
  init: RequestInit,
  timeoutMs = GATEWAY_TOKEN_REQUEST_TIMEOUT_MS,
): Promise<GatewayTokenResponse> {
  const response = await boundedFetch(url, init, {
    timeoutMs,
    // Token JSON has no published byte limit; do not invent a truncation policy.
    maxResponseBytes: Number.MAX_SAFE_INTEGER,
    invalidBoundsError: () =>
      new ElizaError("Invalid gateway token deadline.", {
        code: "GATEWAY_TOKEN_DEADLINE_INVALID",
      }),
    responseTooLargeError: () =>
      new ElizaError("Gateway token response exceeds representable size.", {
        code: "GATEWAY_TOKEN_RESPONSE_TOO_LARGE",
      }),
    timeoutMessage: "Gateway token request deadline expired.",
    cancellationMessage: "Gateway token request cancelled.",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new ElizaError(
      `Failed to acquire gateway token: HTTP ${response.status} - ${detail}`,
      {
        code: "GATEWAY_TOKEN_HTTP_FAILED",
        context: { status: response.status },
      },
    );
  }
  return parseGatewayTokenResponse(await response.json());
}
