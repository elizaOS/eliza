/**
 * GET /api/v1/api-keys — list keys for the authenticated user's organization.
 * POST /api/v1/api-keys — create a new key (returns plainKey once).
 *
 * API key management requires a session — API keys cannot manage other API keys.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

import { createApiKeySchema } from "./schemas";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

function toClientApiKey(
  apiKey: Awaited<ReturnType<typeof apiKeysService.listByOrganization>>[number],
) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    description: apiKey.description,
    key_prefix: apiKey.key_prefix,
    permissions: apiKey.permissions,
    rate_limit: apiKey.rate_limit,
    is_active: apiKey.is_active,
    usage_count: apiKey.usage_count,
    last_used_at: apiKey.last_used_at,
    created_at: apiKey.created_at,
    expires_at: apiKey.expires_at,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const keys = await apiKeysService.listByOrganization(user.organization_id);
    return c.json({ keys: keys.map(toClientApiKey) });
  } catch (error) {
    logger.error("Error fetching API keys:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const body = await c.req.json();
    const { name, description, permissions, rate_limit, expires_at } =
      createApiKeySchema.parse(body);

    const { apiKey, plainKey } = await apiKeysService.create({
      name,
      description,
      organization_id: user.organization_id,
      user_id: user.id,
      permissions,
      rate_limit,
      expires_at: expires_at ?? null,
      is_active: true,
    });

    return c.json(
      {
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          key_prefix: apiKey.key_prefix,
          created_at: apiKey.created_at,
          permissions: apiKey.permissions,
          rate_limit: apiKey.rate_limit,
          expires_at: apiKey.expires_at,
        },
        plainKey,
      },
      201,
    );
  } catch (error) {
    logger.error("Error creating API key:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
