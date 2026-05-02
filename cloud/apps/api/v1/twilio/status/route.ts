/**
 * Twilio Status Route
 *
 * Returns the current Twilio connection status for the organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const [status, accountSid] = await Promise.all([
      twilioAutomationService.getConnectionStatus(user.organization_id),
      twilioAutomationService.getAccountSid(user.organization_id),
    ]);

    // Include webhook URL for reference
    const webhookUrl = twilioAutomationService.getWebhookUrl(user.organization_id);

    // Map properties for frontend compatibility:
    // - `configured` -> `webhookConfigured`
    // - Include `accountSid` for UI display
    const { configured, ...restStatus } = status;
    return c.json({
      ...restStatus,
      webhookConfigured: configured,
      webhookUrl,
      accountSid: accountSid || undefined,
    });
  } catch (error) {
    logger.error("[Twilio Status] Failed to get status", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
