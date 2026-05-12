/**
 * Blooio Connect Route
 *
 * Stores Blooio API credentials for an organization.
 * Unlike OAuth providers, Blooio uses API key authentication.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const blooioConnectSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  webhookSecret: z.string().optional(),
  phoneNumber: z.string().optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }

    const parsedBody = blooioConnectSchema.safeParse(body);
    if (!parsedBody.success) {
      return c.json(
        {
          error: parsedBody.error.issues[0]?.message || "Invalid request body",
        },
        400,
      );
    }

    // Frontend sends `phoneNumber`, map to internal `fromNumber`
    const { apiKey, webhookSecret, phoneNumber } = parsedBody.data;
    const fromNumber = phoneNumber;

    // Validate the API key
    const validation = await blooioAutomationService.validateApiKey(apiKey);

    if (!validation.valid) {
      return c.json({ error: validation.error || "Invalid API key" }, 400);
    }

    // Store credentials
    await blooioAutomationService.storeCredentials(user.organization_id, user.id, {
      apiKey,
      webhookSecret,
      fromNumber,
    });

    // Get the webhook URL to display to user
    const webhookUrl = blooioAutomationService.getWebhookUrl(user.organization_id);

    await invalidateOAuthState(user.organization_id, "blooio", user.id);

    logger.info("[Blooio Connect] Credentials stored", {
      organizationId: user.organization_id,
      userId: user.id,
      hasFromNumber: !!fromNumber,
    });

    return c.json({
      success: true,
      message: "Blooio connected successfully",
      webhookUrl,
      instructions:
        "Configure this webhook URL in your Blooio dashboard to receive inbound messages.",
    });
  } catch (error) {
    logger.error("[Blooio Connect] Failed to connect", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
