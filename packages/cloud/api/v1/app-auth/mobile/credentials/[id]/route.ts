/**
 * Revokes one native app credential through an interactive account session.
 * Ownership is proven on primary storage and retries return the same durable
 * tombstone without disclosing credentials belonging to another account.
 */

import { Hono } from "hono";
import { createTransactionalAudit } from "@/api-app/services/audit-transactional";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireSessionUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STRICT));

app.delete("/", async (c) => {
  try {
    const user = await requireSessionUserWithOrg(c);
    const credentialId = c.req.param("id");
    if (!credentialId) throw NotFoundError("Mobile credential not found");
    const audit = createTransactionalAudit();
    const result = await apiKeysService.revokeMobileCredentialForAccount(
      credentialId,
      user.id,
      user.organization_id,
      async (tx) => {
        await audit.write(tx, {
          actor: { type: "user", id: user.id },
          action: "api_key.revoke",
          result: "success",
          resource: { type: "api_key", id: credentialId },
          org_id: user.organization_id,
          request_id: c.get("requestId"),
          metadata: { key_id: credentialId, reason: "account_device_revoke" },
        });
      },
    );
    if (!result) throw NotFoundError("Mobile credential not found");
    await audit.publish();

    return c.json({ success: true, ...result.receipt });
  } catch (error) {
    // error-policy:J1 Account recovery failures remain explicit HTTP errors.
    logger.error("[MobileAppAuth] Account credential revocation failed", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
