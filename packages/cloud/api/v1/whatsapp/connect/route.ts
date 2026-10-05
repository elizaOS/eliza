/**
 * WhatsApp Connect Route
 *
 * Stores WhatsApp Business API credentials for an organization.
 * Validates the access token against Meta Graph API before storing.
 * Auto-generates a verify token for webhook handshake.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { whatsappAutomationService } from "@elizaos/cloud-shared/lib/services/whatsapp-automation";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const WhatsappConnectBody = z.object({
  accessToken: z.string().min(1, "Access token is required"),
  phoneNumberId: z.string().min(1, "Phone Number ID is required"),
  appSecret: z.string().min(1, "App Secret is required"),
  businessPhone: z.string().optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    const parsed = WhatsappConnectBody.safeParse(rawBody);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message || "Invalid request body";
      return c.json({ error: message }, 400);
    }
    const { accessToken, phoneNumberId, appSecret, businessPhone } =
      parsed.data;

    // Validate the access token by calling Meta Graph API
    const validation = await whatsappAutomationService.validateAccessToken(
      accessToken,
      phoneNumberId,
    );

    if (!validation.valid) {
      return c.json({ error: validation.error || "Invalid credentials" }, 400);
    }

    // Auto-generate a verify token for webhook handshake
    const verifyToken = whatsappAutomationService.generateVerifyToken();

    // Store credentials
    await whatsappAutomationService.storeCredentials(
      user.organization_id,
      user.id,
      {
        accessToken,
        phoneNumberId,
        appSecret,
        verifyToken,
        businessPhone: businessPhone || validation.phoneDisplay,
      },
    );

    // Get the webhook URL to display to user
    const webhookUrl = whatsappAutomationService.getWebhookUrl(
      user.organization_id,
    );

    logger.info("[WhatsApp Connect] Credentials stored", {
      organizationId: user.organization_id,
      userId: user.id,
      hasBusinessPhone: !!(businessPhone || validation.phoneDisplay),
    });

    return c.json({
      success: true,
      message: "WhatsApp connected successfully",
      webhookUrl,
      verifyToken,
      businessPhone: businessPhone || validation.phoneDisplay,
      instructions:
        "Configure the webhook URL and verify token in your Meta App Dashboard under WhatsApp > Configuration.",
    });
  } catch (error) {
    logger.error("[WhatsApp Connect] Failed to connect", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
