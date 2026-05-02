/**
 * GET /api/eliza-app/user/me
 *
 * Returns the current eliza-app user's profile + organization. Auth via
 * Bearer eliza-app session token.
 */

import { Hono } from "hono";
import { organizationsRepository } from "@/db/repositories/organizations";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { elizaAppSessionService, elizaAppUserService } from "@/lib/services/eliza-app";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Authorization header required", code: "UNAUTHORIZED" }, 401);
  }

  const session = await elizaAppSessionService.validateAuthHeader(authHeader);
  if (!session) {
    return c.json({ error: "Invalid or expired session", code: "INVALID_SESSION" }, 401);
  }

  const user = await elizaAppUserService.getById(session.userId);
  if (!user) {
    logger.warn("[ElizaApp UserMe] User not found", { userId: session.userId });
    return c.json({ error: "User not found", code: "USER_NOT_FOUND" }, 404);
  }

  let organization = null;
  if (user.organization_id) {
    const org = await organizationsRepository.findById(user.organization_id);
    if (org) {
      organization = {
        id: org.id,
        name: org.name,
        credit_balance: org.credit_balance,
      };
    }
  }

  return c.json({
    user: {
      id: user.id,
      telegram_id: user.telegram_id,
      telegram_username: user.telegram_username,
      telegram_first_name: user.telegram_first_name,
      discord_id: user.discord_id,
      discord_username: user.discord_username,
      discord_global_name: user.discord_global_name,
      discord_avatar_url: user.discord_avatar_url,
      whatsapp_id: user.whatsapp_id,
      whatsapp_name: user.whatsapp_name,
      phone_number: user.phone_number,
      name: user.name,
      avatar: user.avatar,
      organization_id: user.organization_id,
      created_at: user.created_at.toISOString(),
    },
    organization,
  });
});

export default app;
