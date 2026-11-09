/** Sanitized HTTP failure details shared by the subscription refresh adapters. */
import { logger } from "@elizaos/core";
import { ElizaError } from "@elizaos/core/protocol";
import type { OAuthSubscriptionProvider } from "./types.ts";

export const OAUTH_REFRESH_HTTP_ERROR = "AUTH_OAUTH_REFRESH_HTTP_ERROR";

export async function createRefreshHttpError(
  provider: OAuthSubscriptionProvider,
  response: Response,
): Promise<ElizaError> {
  let oauthError: "invalid_grant" | "invalid_token" | undefined;
  if (response.status === 400) {
    try {
      const payload: unknown = await response.json();
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const code = (payload as { error?: unknown }).error;
        if (code === "invalid_grant" || code === "invalid_token") {
          oauthError = code;
        }
      }
    } catch {
      // error-policy:J3 A malformed error body cannot establish that the
      // account grant is invalid. The HTTP failure still remains explicit.
    }
  } else {
    try {
      await response.body?.cancel();
    } catch {
      // error-policy:J6 Releasing a rejected response is best-effort. Keep the
      // provider's HTTP failure and never include its body in diagnostics.
      logger.warn(
        { provider, status: response.status },
        "[auth] Could not release rejected refresh response",
      );
    }
  }
  return new ElizaError(
    `${provider} token refresh failed (HTTP ${response.status}${oauthError ? `, ${oauthError}` : ""})`,
    {
      code: OAUTH_REFRESH_HTTP_ERROR,
      severity:
        response.status >= 500 || response.status === 429
          ? "ephemeral"
          : "fatal",
      context: {
        provider,
        status: response.status,
        ...(oauthError ? { oauthError } : {}),
      },
    },
  );
}
