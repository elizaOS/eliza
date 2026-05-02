/**
 * Twilio Disconnect Route
 *
 * Removes Twilio credentials for an organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handleDisconnect(c: AppContext) {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    await twilioAutomationService.removeCredentials(user.organization_id, user.id);

    await invalidateOAuthState(user.organization_id, "twilio", user.id);

    logger.info("[Twilio Disconnect] Credentials removed", {
      organizationId: user.organization_id,
      userId: user.id,
    });

    return c.json({
      success: true,
      message: "Twilio disconnected successfully",
    });
  } catch (error) {
    logger.error("[Twilio Disconnect] Failed to disconnect", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

// Support both POST and DELETE methods for disconnect
app.post("/", handleDisconnect);
app.delete("/", handleDisconnect);

export default app;
