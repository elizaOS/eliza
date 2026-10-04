/**
 * WhatsApp Disconnect Route
 *
 * Removes WhatsApp credentials for an organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { whatsappAutomationService } from "@elizaos/cloud-shared/lib/services/whatsapp-automation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

async function handleDisconnect(c: AppContext) {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    await whatsappAutomationService.removeCredentials(
      user.organization_id,
      user.id,
    );

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
