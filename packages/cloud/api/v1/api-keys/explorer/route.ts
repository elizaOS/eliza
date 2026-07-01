/**
 * GET /api/v1/api-keys/explorer
 * Gets or creates a per-user API key for the API Explorer page.
 */

import { Hono } from "hono";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const EXPLORER_KEY_NAME = "API Explorer Key";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

// D-1: api_keys plaintext is encrypted at rest and only revealed at creation
// time. The previous "find existing usable key and return its plaintext on
// every GET" behavior is no longer possible — we'd have to decrypt on every
// request, defeating the one-time-reveal model. We now always rotate: any
// prior explorer key for the user is deactivated and a fresh one is minted.
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    await apiKeysService.deactivateUserKeysByName(user.id, EXPLORER_KEY_NAME);

    const { apiKey, plainKey } = await apiKeysService.create({
      name: EXPLORER_KEY_NAME,
      description:
        "Auto-generated key for testing APIs in the API Explorer. Usage is billed to your account.",
      organization_id: user.organization_id,
      user_id: user.id,
      rate_limit: 100,
      expires_at: null,
      is_active: true,
    });

    return c.json(
      {
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          key_prefix: apiKey.key_prefix,
          key: plainKey,
          created_at: apiKey.created_at,
          is_active: apiKey.is_active,
          usage_count: 0,
          last_used_at: null,
        },
        isNew: true,
      },
      201,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        return c.json({ error: "Please sign in to use the API Explorer" }, 401);
      }
      if (error.status === 403) {
        return c.json(
          {
            error: "Please complete your account setup to use the API Explorer",
          },
          403,
        );
      }
    }
    logger.error("Error getting/creating explorer API key:", error);
    return failureResponse(c, error);
  }
});

export default app;
