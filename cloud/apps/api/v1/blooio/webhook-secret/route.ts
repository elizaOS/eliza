/**
 * Blooio Webhook Secret Route
 *
 * Stores the webhook signing secret after initial connection.
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

const WebhookSecretBody = z.object({
  webhookSecret: z.string().min(1, "Webhook secret is required"),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const orgId = user.organization_id;

    const parsed = WebhookSecretBody.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Webhook secret is required" }, 400);
    }
    const { webhookSecret } = parsed.data;

    if (!webhookSecret.startsWith("whsec_")) {
      return c.json({ error: "Invalid format. Secret should start with 'whsec_'" }, 400);
    }

    // Fetch existing credentials in parallel
    const [apiKey, fromNumber] = await Promise.all([
      blooioAutomationService.getApiKey(orgId),
      blooioAutomationService.getFromNumber(orgId),
    ]);

    if (!apiKey) {
      return c.json({ error: "Please connect Blooio first" }, 400);
    }

    await blooioAutomationService.storeCredentials(orgId, user.id, {
      apiKey,
      webhookSecret,
      fromNumber: fromNumber || undefined,
    });

    await invalidateOAuthState(orgId, "blooio", user.id);

    logger.info("[Blooio] Webhook secret stored", { orgId });

    return c.json({ success: true });
  } catch (error) {
    logger.error("[Blooio] Failed to save webhook secret", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
