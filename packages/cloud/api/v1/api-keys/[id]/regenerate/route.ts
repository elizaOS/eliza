/**
 * POST /api/v1/api-keys/[id]/regenerate — rotate a user-managed key.
 * Mobile lifecycle credentials keep their fixed secret and are not addressable here.
 */

import { Hono } from "hono";
import { assertOrgMembership } from "@/api-app/middleware/org-membership";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getManageableById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    await assertOrgMembership(user, existingKey.organization_id, {
      resourceType: "api_key",
      resourceId: id,
      c,
    });

    const { apiKey: updatedKey, plainKey } =
      await apiKeysService.regenerate(id);

    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: user.id },
        action: "api_key.rotate",
        result: "success",
        resource: { type: "api_key", id },
        org_id: user.organization_id,
        request_id: c.get("requestId"),
        metadata: { key_id: id, reason: "user_regenerate" },
      })
      .catch((err: unknown) => {
        // error-policy:J7 audit-log emit is best-effort telemetry; a failed emit must not fail an already-rotated key. Observed via this warn.
        logger.warn("[API Keys] rotate audit emit failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return c.json({
      apiKey: {
        id: updatedKey.id,
        name: updatedKey.name,
        description: updatedKey.description,
        key_prefix: updatedKey.key_prefix,
        created_at: updatedKey.created_at,
        rate_limit: updatedKey.rate_limit,
        expires_at: updatedKey.expires_at,
      },
      plainKey,
    });
  } catch (error) {
    logger.error("Error regenerating API key:", error);
    return failureResponse(c, error);
  }
});

export default app;
