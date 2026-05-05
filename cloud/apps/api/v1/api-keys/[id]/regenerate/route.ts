/**
 * POST /api/v1/api-keys/[id]/regenerate — invalidate the old key and emit a new one.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    if (existingKey.organization_id !== user.organization_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { key: newKey, hash: newHash, prefix: newPrefix } = apiKeysService.generateApiKey();

    const updatedKey = await apiKeysService.update(id, {
      key: newKey,
      key_hash: newHash,
      key_prefix: newPrefix,
      updated_at: new Date(),
    });
    if (!updatedKey) return c.json({ error: "Failed to regenerate API key" }, 500);

    return c.json({
      apiKey: {
        id: updatedKey.id,
        name: updatedKey.name,
        description: updatedKey.description,
        key_prefix: updatedKey.key_prefix,
        created_at: updatedKey.created_at,
        permissions: updatedKey.permissions,
        rate_limit: updatedKey.rate_limit,
        expires_at: updatedKey.expires_at,
      },
      plainKey: newKey,
    });
  } catch (error) {
    logger.error("Error regenerating API key:", error);
    return failureResponse(c, error);
  }
});

export default app;
