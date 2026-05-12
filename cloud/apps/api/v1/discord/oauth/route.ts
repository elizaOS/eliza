/**
 * Discord OAuth API
 *
 * Initiates the OAuth2 flow to add the bot to a Discord server.
 */

import { randomBytes } from "crypto";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { resolveSafeRedirectTarget } from "@/lib/security/redirect-validation";
import { discordAutomationService } from "@/lib/services/discord-automation";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    // Check if Discord is configured
    if (!discordAutomationService.isOAuthConfigured()) {
      return c.json({ error: "Discord integration not configured" }, 503);
    }

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const defaultReturnPath = "/dashboard/settings?tab=connections";
    const safeReturnTarget = resolveSafeRedirectTarget(
      c.req.query("returnUrl"),
      baseUrl,
      defaultReturnPath,
    );
    const returnUrl = `${safeReturnTarget.pathname}${safeReturnTarget.search}${safeReturnTarget.hash}`;

    const state = {
      organizationId: user.organization_id,
      userId: user.id,
      returnUrl,
      nonce: randomBytes(16).toString("hex"),
    };

    const oauthUrl = discordAutomationService.generateOAuthUrl(state);

    return Response.redirect(oauthUrl);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
