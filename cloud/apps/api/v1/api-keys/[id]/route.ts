/**
 * DELETE /api/v1/api-keys/[id] — delete a key (org-scoped).
 * PATCH  /api/v1/api-keys/[id] — partial update.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

import { updateApiKeySchema } from "../schemas";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    if (existingKey.organization_id !== user.organization_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await apiKeysService.delete(id);
    return c.json({ success: true });
  } catch (error) {
    logger.error("[API Keys] Error deleting API key", { error });
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    if (existingKey.organization_id !== user.organization_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json();
    const { name, description, permissions, rate_limit, is_active, expires_at } =
      updateApiKeySchema.parse(body);

    const updatedKey = await apiKeysService.update(id, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(permissions !== undefined && { permissions }),
      ...(rate_limit !== undefined && { rate_limit }),
      ...(is_active !== undefined && { is_active }),
      ...(expires_at !== undefined && { expires_at }),
    });

    if (!updatedKey) return c.json({ error: "Failed to update API key" }, 500);

    return c.json({
      apiKey: {
        id: updatedKey.id,
        name: updatedKey.name,
        description: updatedKey.description,
        key_prefix: updatedKey.key_prefix,
        created_at: updatedKey.created_at,
        permissions: updatedKey.permissions,
        rate_limit: updatedKey.rate_limit,
        is_active: updatedKey.is_active,
        expires_at: updatedKey.expires_at,
      },
    });
  } catch (error) {
    logger.error("[API Keys] Error updating API key", { error });
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
