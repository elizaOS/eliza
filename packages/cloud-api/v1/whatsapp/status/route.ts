/**
 * WhatsApp Status Route
 *
 * Returns the current WhatsApp connection status for the organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { whatsappAutomationService } from "@/lib/services/whatsapp-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const orgId = user.organization_id;

    // Fetch status and verify token in parallel
    const [status, verifyToken] = await Promise.all([
      whatsappAutomationService.getConnectionStatus(orgId),
      whatsappAutomationService.getVerifyToken(orgId),
    ]);

    return c.json({
      connected: status.connected,
      configured: status.configured,
      businessPhone: status.businessPhone,
      webhookUrl: whatsappAutomationService.getWebhookUrl(orgId),
      verifyToken: verifyToken || undefined,
      error: status.error,
    });
  } catch (error) {
    logger.error("[WhatsApp Status] Failed to get status", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
