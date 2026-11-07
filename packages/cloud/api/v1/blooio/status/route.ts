/**
 * Blooio Status Route
 *
 * Returns the current Blooio connection status for the organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { blooioAutomationService } from "@elizaos/cloud-shared/lib/services/blooio-automation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
