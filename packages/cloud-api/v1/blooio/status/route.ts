/**
 * Blooio Status Route
 *
 * Returns the current Blooio connection status for the organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const orgId = user.organization_id;

    // Fetch status and webhook secret in parallel
    const [status, webhookSecret] = await Promise.all([
      blooioAutomationService.getConnectionStatus(orgId),
      blooioAutomationService.getWebhookSecret(orgId),
    ]);

    const { fromNumber, configured, ...restStatus } = status;
    return c.json({
      ...restStatus,
      phoneNumber: fromNumber,
      webhookConfigured: configured,
      webhookUrl: blooioAutomationService.getWebhookUrl(orgId),
      hasWebhookSecret: Boolean(webhookSecret),
    });
  } catch (error) {
    logger.error("[Blooio Status] Failed to get status", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
