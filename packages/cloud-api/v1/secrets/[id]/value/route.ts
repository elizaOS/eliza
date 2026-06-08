/**
 * GET /api/v1/secrets/[id]/value — decrypt and return individual secret value.
 */

import { Hono } from "hono";
import { requireApiKeyPermission } from "@/api-app/middleware/auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AuditContext } from "@/lib/services/secrets";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));
app.use("*", requireApiKeyPermission("keys:write"));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const audit: AuditContext = {
      actorType: "user",
      actorId: user.id,
      actorEmail: user.email ?? undefined,
      ipAddress:
        c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
      userAgent: c.req.header("user-agent"),
      requestId: c.get("requestId"),
      endpoint: c.req.path,
    };

    try {
      const value = await secretsService.getDecryptedValue(
        id,
        user.organization_id,
        audit,
      );
      return c.json({ value });
    } catch (err) {
      if (err instanceof Error && err.message === "Secret not found") {
        return c.json({ error: "Secret not found" }, 404);
      }
      throw err;
    }
  } catch (error) {
    logger.error(
      "[Secrets API] Error retrieving decrypted secret value:",
      error,
    );
    return failureResponse(c, error);
  }
});

export default app;
