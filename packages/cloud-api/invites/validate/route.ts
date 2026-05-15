/**
 * GET /api/invites/validate?token=xxx
 * Public endpoint — validates an invitation token and returns details.
 */

import { Hono } from "hono";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { invitesService } from "@/lib/services/invites";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ success: false, valid: false, error: "Token is required" }, 400);
    }

    const validation = await invitesService.validateToken(token);
    if (!validation.valid) {
      return c.json({ success: false, valid: false, error: validation.error });
    }

    return c.json({
      success: true,
      valid: true,
      data: {
        organization_name: validation.invite!.organization.name,
        organization_slug: validation.invite!.organization.slug,
        role: validation.invite!.invited_role,
        invited_email: validation.invite!.invited_email,
        expires_at: validation.invite!.expires_at,
      },
    });
  } catch (error) {
    logger.error("Error validating invite token:", error);
    return c.json(
      {
        success: false,
        valid: false,
        error: error instanceof Error ? error.message : "Failed to validate invitation",
      },
      500,
    );
  }
});

export default app;
