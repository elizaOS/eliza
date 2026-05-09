/**
 * Twilio SMS Webhook Handler
 *
 * Receives inbound SMS/MMS messages from Twilio and routes them
 * to the appropriate agent for processing.
 */

import { calculateTwilioSmsBilling, resolveTwilioSmsCostPerSegment } from "@elizaos/billing";
import { Hono } from "hono";
import { ZodError } from "zod";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { usageService } from "@/lib/services/usage";
import { isAlreadyProcessed, markAsProcessed } from "@/lib/utils/idempotency";
import { logger } from "@/lib/utils/logger";
import {
  extractMediaUrls,
  parseTwilioWebhookEvent,
  type TwilioWebhookEvent,
  verifyTwilioSignature,
} from "@/lib/utils/twilio-api";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function resolveTwilioVerificationUrl(c: AppContext): string {
  const url = new URL(c.req.url);
  const forwardedProto = firstForwardedHeaderValue(c.req.header("x-forwarded-proto"));
  const forwardedHost = firstForwardedHeaderValue(c.req.header("x-forwarded-host"));

  if (forwardedProto) {
    url.protocol = `${forwardedProto}:`;
  }

  if (forwardedHost) {
    url.host = forwardedHost;
  }

  return url.toString();
}

function resolveSmsCostPerSegment(env: AppContext["env"]): number {
  const raw = env.TWILIO_SMS_COST_PER_SEGMENT_USD;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      logger.warn("[TwilioWebhook] Invalid TWILIO_SMS_COST_PER_SEGMENT_USD; using default", {
        raw,
      });
    }
  }
  return resolveTwilioSmsCostPerSegment(raw);
}

async function handleTwilioWebhook(c: AppContext): Promise<Response> {
  const orgId = c.req.param("orgId") ?? "";
  if (!orgId) {
    return c.text("Organization ID is required", 400);
  }

  try {
    const formData = await c.req.formData();
    const webhookData: Record<string, string> = {};
    formData.forEach((value: FormDataEntryValue, key: string) => {
      webhookData[key] = value.toString();
    });

    // Validate the webhook payload using Zod schema
    let event: TwilioWebhookEvent;
    try {
      event = parseTwilioWebhookEvent(webhookData);
    } catch (validationError) {
      if (validationError instanceof ZodError) {
        logger.warn("[TwilioWebhook] Invalid webhook payload", {
          orgId,
          errors: validationError.issues.map((e) => ({ path: e.path, message: e.message })),
        });
        return c.text("Invalid webhook payload", 400);
      }
      throw validationError;
    }

    const isProduction = c.env.NODE_ENV === "production";
    const skipVerification = c.env.SKIP_WEBHOOK_VERIFICATION === "true" && !isProduction;
    const authToken = await twilioAutomationService.getAuthToken(orgId);

    if (c.env.SKIP_WEBHOOK_VERIFICATION === "true" && isProduction) {
      logger.error("[TwilioWebhook] SKIP_WEBHOOK_VERIFICATION ignored in production", { orgId });
    }

    if (skipVerification) {
      logger.warn("[TwilioWebhook] Signature validation disabled (non-production)", { orgId });
    } else if (!authToken) {
      logger.error("[TwilioWebhook] No auth token configured - rejecting webhook", { orgId });
      return c.text("Webhook not configured", 500);
    } else {
      const signature = c.req.header("X-Twilio-Signature") || "";
      const url = resolveTwilioVerificationUrl(c);
      const isValid = await verifyTwilioSignature(authToken, signature, url, webhookData);
      if (!isValid) {
        logger.warn("[TwilioWebhook] Signature validation failed", { orgId });
        return c.text("Invalid signature", 401);
      }
    }

    const idempotencyKey = `twilio:${event.MessageSid}`;
    if (await isAlreadyProcessed(idempotencyKey)) {
      logger.info("[TwilioWebhook] Duplicate message, skipping", {
        orgId,
        messageSid: event.MessageSid,
      });
      return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
        "Content-Type": "application/xml",
      });
    }

    logger.info("[TwilioWebhook] Received SMS", {
      orgId,
      messageSid: event.MessageSid,
      from: event.From,
      to: event.To,
      hasBody: !!event.Body,
      numMedia: event.NumMedia,
    });

    await handleIncomingMessage(c, orgId, event);
    await markAsProcessed(idempotencyKey, "twilio");

    return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
      "Content-Type": "application/xml",
    });
  } catch (error) {
    logger.error("[TwilioWebhook] Error processing webhook", {
      orgId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return c.text("Internal server error", 500);
  }
}

const app = new Hono<AppEnv>();
app.post("/", rateLimit(RateLimitPresets.AGGRESSIVE), (c) => handleTwilioWebhook(c));

/**
 * Handle incoming SMS message from Twilio
 */
async function handleIncomingMessage(
  c: AppContext,
  orgId: string,
  event: TwilioWebhookEvent,
): Promise<void> {
  const [{ messageRouterService }, { agentGatewayRouterService }] = await Promise.all([
    import("@/lib/services/message-router"),
    import("@/lib/services/agent-gateway-router"),
  ]);

  const from = event.From;
  const to = event.To;
  const body = event.Body?.trim();
  const mediaUrls = extractMediaUrls(event);

  if (!body && mediaUrls.length === 0) {
    logger.info("[TwilioWebhook] Skipping empty message", { orgId, from });
    return;
  }

  logger.info("[TwilioWebhook] Processing incoming message", {
    orgId,
    from,
    to,
    hasBody: !!body,
    numMedia: mediaUrls.length,
    fromCity: event.FromCity,
    fromState: event.FromState,
    fromCountry: event.FromCountry,
  });

  const startTime = Date.now();

  // Build message context for routing
  const messageContext = {
    from,
    to,
    body: body || "",
    provider: "twilio" as const,
    providerMessageId: event.MessageSid,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    messageType: (mediaUrls.length > 0 ? "mms" : "sms") as "sms" | "mms",
    metadata: {
      fromCity: event.FromCity,
      fromState: event.FromState,
      fromCountry: event.FromCountry,
      accountSid: event.AccountSid,
    },
  };

  const routed = await agentGatewayRouterService.routePhoneMessage({
    organizationId: orgId,
    provider: "twilio",
    from,
    to,
    body: body || "",
    providerMessageId: event.MessageSid,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    metadata: messageContext.metadata,
  });

  if (!routed.handled) {
    logger.warn("[TwilioWebhook] Failed to route message to owned Agent", {
      orgId,
      from,
      to,
      reason: routed.reason,
      agentId: routed.agentId,
    });
    return;
  }

  if (routed.replyText?.trim()) {
    // Send the response back via Twilio
    const sent = await messageRouterService.sendMessage({
      to: from, // Reply to sender
      from: to, // From our number
      body: routed.replyText.trim(),
      provider: "twilio",
      organizationId: orgId,
    });

    const responseTime = Date.now() - startTime;

    if (sent) {
      const billing = calculateTwilioSmsBilling(
        routed.replyText.trim(),
        resolveSmsCostPerSegment(c.env),
      );

      try {
        await usageService.create({
          organization_id: orgId,
          user_id: routed.userId ?? null,
          type: "twilio_sms",
          model: "twilio-sms",
          provider: "twilio",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(billing.rawCost),
          output_cost: String(0),
          markup: String(billing.markup),
          request_id: event.MessageSid,
          is_successful: true,
          metadata: {
            channel: "sms",
            messageSid: event.MessageSid,
            from,
            to,
            segments: billing.segments,
            costPerSegment: billing.costPerSegment,
            billing,
          },
        });
      } catch (error) {
        logger.error("[TwilioWebhook] Failed to persist Twilio SMS usage", {
          orgId,
          messageSid: event.MessageSid,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.info("[TwilioWebhook] Agent response sent", {
        orgId,
        from,
        to,
        responseTime,
      });
    } else {
      logger.error("[TwilioWebhook] Failed to send agent response", {
        orgId,
        from,
        to,
      });
    }
  }
}

app.get("/", (c) => c.json({ status: "ok", service: "twilio-webhook" }));

export default app;
