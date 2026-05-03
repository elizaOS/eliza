/**
 * WhatsApp Disconnect Route
 *
 * Removes WhatsApp credentials for an organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { whatsappAutomationService } from "@/lib/services/whatsapp-automation";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handleDisconnect(c: AppContext) {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    await whatsappAutomationService.removeCredentials(user.organization_id, user.id);

    logger.info("[WhatsApp Disconnect] Credentials removed", {
      organizationId: user.organization_id,
      userId: user.id,
    });

    return c.json({
      success: true,
      message: "WhatsApp disconnected successfully",
    });
  } catch (error) {
    logger.error("[WhatsApp Disconnect] Failed to disconnect", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

// Support both POST and DELETE methods for disconnect
app.post("/", handleDisconnect);
app.delete("/", handleDisconnect);

export default app;
