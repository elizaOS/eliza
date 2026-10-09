/**
 * Revokes only the credential proven by the secret in this request.
 * The presented mobile-prefixed secret and authenticated database row must
 * agree on one exact identity; a response-loss retry can recover only that
 * credential's durable tombstone.
 */

import { requireApiKeyCredential } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  AuthenticationError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  apiKeysService,
  isMobileApiKeySecret,
} from "@elizaos/cloud-shared/lib/services/api-keys";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createTransactionalAudit } from "@/api-app/services/audit-transactional";

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

type SelfRevocationResult = NonNullable<
  Awaited<ReturnType<typeof apiKeysService.revokePresentedMobileCredential>>
>;

/** Durable `api_key.revoke` record written inside the tombstone transaction. */
function selfRevocationAudit(c: AppContext) {
  const audit = createTransactionalAudit();
  return {
    audit,
    write: async (
      tx: Parameters<typeof audit.write>[0],
      result: SelfRevocationResult,
    ) => {
      await audit.write(tx, {
        actor: { type: "user", id: result.userId },
        action: "api_key.revoke",
        result: "success",
        resource: { type: "api_key", id: result.receipt.credentialId },
        org_id: result.organizationId,
        request_id: c.get("requestId"),
        metadata: {
          key_id: result.receipt.credentialId,
          reason: "credential_self_revoke",
        },
      });
    },
  };
}

app.delete("/", async (c) => {
  try {
    const standardSecret = readSinglePresentedApiKey(c);
    if (standardSecret && /^eliza_[0-9a-f]{64}$/.test(standardSecret)) {
      const selfAudit = selfRevocationAudit(c);
      const result = await apiKeysService.revokePresentedStandardCredential(
        standardSecret,
        selfAudit.write,
      );
      if (!result)
        throw AuthenticationError("API key identity could not be proven");
      await selfAudit.audit.publish();
      return c.json({ success: true, ...result.receipt });
    }
    let credential: Awaited<ReturnType<typeof requireApiKeyCredential>>;
    try {
      credential = await requireApiKeyCredential(c);
    } catch (error) {
      // error-policy:J1 A 401 may be a response-loss retry, while a 503 means
      // the authentication cache could not establish state. The primary-store
      // lookup below still requires the exact presented mobile secret before
      // it can return or create that credential's durable tombstone.
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 503)
      ) {
        const presented = readSinglePresentedApiKey(c);
        const selfAudit = selfRevocationAudit(c);
        const result =
          presented && isMobileApiKeySecret(presented)
            ? await apiKeysService.revokePresentedMobileCredential(
                presented,
                selfAudit.write,
              )
            : null;
        if (result) {
          await selfAudit.audit.publish();
          return c.json({ success: true, ...result.receipt });
        }
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

    const selfAudit = selfRevocationAudit(c);
    const result = await apiKeysService.revokeExactMobileCredential(
      credential,
      selfAudit.write,
    );
    await selfAudit.audit.publish();
    return c.json({ success: true, ...result.receipt });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns a canonical auth or dependency failure.
    logger.error("[API Keys] Current credential self-revoke failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
