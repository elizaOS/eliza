/**
 * Discord OAuth API
 *
 * Initiates the OAuth2 flow to add the bot to a Discord server.
 */

import { randomBytes } from "node:crypto";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { resolveSafeRedirectTarget } from "@elizaos/cloud-shared/lib/security/redirect-validation";
import { discordAutomationService } from "@elizaos/cloud-shared/lib/services/discord-automation";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    // Check if Discord is configured
    if (!discordAutomationService.isOAuthConfigured()) {
      return c.json({ error: "Discord integration not configured" }, 503);
    }

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const defaultReturnPath = "/cloud/connectors";
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
