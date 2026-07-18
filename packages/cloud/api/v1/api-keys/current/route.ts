/**
 * Revokes only the first-party mobile credential authenticating this request.
 * The presented mobile-prefixed secret and authenticated database row must
 * agree on one exact identity; a response-loss retry can recover only that
 * credential's durable tombstone.
 */
import { Hono } from "hono";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import {
  ApiError,
  AuthenticationError,
  failureResponse,
} from "@/lib/api/cloud-worker-errors";
import { requireApiKeyCredential } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService, isMobileApiKeySecret } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

function readSinglePresentedApiKey(c: AppContext): string | null {
  const headerKey =
    (c.req.header("X-API-Key") ?? c.req.header("x-api-key"))?.trim() || null;
  const authorization = c.req.header("authorization")?.trim() ?? null;
  const bearerKey =
    authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
  if (headerKey && bearerKey) return null;
  return headerKey ?? bearerKey;
}

app.delete("/", async (c) => {
  try {
    let credential: Awaited<ReturnType<typeof requireApiKeyCredential>>;
    try {
      credential = await requireApiKeyCredential(c);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const presented = readSinglePresentedApiKey(c);
        const receipt =
          presented && isMobileApiKeySecret(presented)
            ? await apiKeysService.revokePresentedMobileCredential(presented)
            : null;
        if (receipt) return c.json({ success: true, ...receipt });
      }
      throw error;
    }
    const apiKeyId = c.get("apiKeyId");
    const presented = readSinglePresentedApiKey(c);
    if (
      c.get("authMethod") !== "api_key" ||
      !apiKeyId ||
      apiKeyId !== credential.id ||
      !presented ||
      !isMobileApiKeySecret(presented) ||
      !credential.source_app_id
    ) {
      throw AuthenticationError("Mobile API key identity could not be proven");
    }

    const receipt =
      await apiKeysService.revokeExactMobileCredential(credential);
    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: credential.user_id },
        action: "api_key.revoke",
        result: "success",
        resource: { type: "api_key", id: credential.id },
        org_id: credential.organization_id,
        request_id: c.get("requestId"),
        metadata: { key_id: credential.id, reason: "credential_self_revoke" },
      })
      .catch((error: unknown) => {
        // error-policy:J7 audit telemetry cannot resurrect an already-revoked credential.
        logger.warn("[API Keys] Self-revoke audit emit failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return c.json({ success: true, ...receipt });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns a canonical auth or dependency failure.
    logger.error("[API Keys] Current credential self-revoke failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
