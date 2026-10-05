/**
 * POST /api/v1/api-keys/[id]/regenerate — rotate a user-managed key.
 * Mobile lifecycle credentials keep their fixed secret and are not addressable here.
 */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@elizaos/cloud-shared/lib/services/api-keys";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { assertOrgMembership } from "@/api-app/middleware/org-membership";
import { createTransactionalAudit } from "@/api-app/services/audit-transactional";

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

    const audit = createTransactionalAudit();
    const { apiKey: updatedKey, plainKey } = await apiKeysService.regenerate(
      id,
      async (tx, replacement) => {
        await audit.write(tx, {
          actor: { type: "user", id: user.id },
          action: "api_key.rotate",
          result: "success",
          resource: { type: "api_key", id },
          org_id: user.organization_id,
          request_id: c.get("requestId"),
          metadata: { key_id: replacement.id, reason: "user_regenerate" },
        });
      },
    );
    await audit.publish();

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
