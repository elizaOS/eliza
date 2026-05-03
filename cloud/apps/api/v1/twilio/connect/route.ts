/**
 * Twilio Connect Route
 *
 * Stores Twilio credentials for an organization.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import { isE164PhoneNumber } from "@/lib/utils/twilio-api";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const twilioConnectSchema = z.object({
  accountSid: z.string().min(1, "Account SID is required"),
  authToken: z.string().min(1, "Auth Token is required"),
  phoneNumber: z.string().min(1, "Phone Number is required"),
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

    const parsedBody = twilioConnectSchema.safeParse(body);
    if (!parsedBody.success) {
      return c.json(
        {
          error: parsedBody.error.issues[0]?.message || "Invalid request body",
        },
        400,
      );
    }

    const { accountSid, authToken, phoneNumber } = parsedBody.data;

    // Validate phone number format
    if (!isE164PhoneNumber(phoneNumber)) {
      return c.json({ error: "Phone number must be in E.164 format (e.g., +15551234567)" }, 400);
    }

    // Validate the credentials
    const validation = await twilioAutomationService.validateCredentials(accountSid, authToken);

    if (!validation.valid) {
      return c.json({ error: validation.error || "Invalid Twilio credentials" }, 400);
    }

    // Store credentials
    await twilioAutomationService.storeCredentials(user.organization_id, user.id, {
      accountSid,
      authToken,
      phoneNumber,
    });

    // Get the webhook URL to display to user
    const webhookUrl = twilioAutomationService.getWebhookUrl(user.organization_id);

    await invalidateOAuthState(user.organization_id, "twilio", user.id);

    logger.info("[Twilio Connect] Credentials stored", {
      organizationId: user.organization_id,
      userId: user.id,
      phoneNumber,
      accountName: validation.accountName,
    });

    return c.json({
      success: true,
      message: "Twilio connected successfully",
      accountName: validation.accountName,
      phoneNumber,
      webhookUrl,
      instructions:
        "Configure this webhook URL in your Twilio phone number settings to receive inbound SMS.",
    });
  } catch (error) {
    logger.error("[Twilio Connect] Failed to connect", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
