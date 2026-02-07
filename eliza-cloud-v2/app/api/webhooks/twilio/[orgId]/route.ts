/**
 * Twilio SMS Webhook Handler
 *
 * Receives inbound SMS/MMS messages from Twilio and routes them
 * to the appropriate agent for processing.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { verifyTwilioSignature, extractMediaUrls, parseTwilioWebhookEvent, type TwilioWebhookEvent } from "@/lib/utils/twilio-api";
import { ZodError } from "zod";
import { RateLimitPresets, withRateLimit } from "@/lib/middleware/rate-limit";
import { isAlreadyProcessed, markAsProcessed } from "@/lib/utils/idempotency";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

async function handleTwilioWebhook(
  request: NextRequest,
  context?: { params: Promise<RouteParams["params"]> },
): Promise<Response> {
  const { orgId } = context?.params ? await context.params : { orgId: "" };

  if (!orgId) {
    return new NextResponse("Organization ID is required", { status: 400 });
  }

  try {
    // Parse form data from Twilio
    const formData = await request.formData();
    const webhookData: Record<string, string> = {};

    formData.forEach((value, key) => {
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
          errors: validationError.issues.map((e) => ({
            path: e.path,
            message: e.message,
          })),
        });
        return new NextResponse("Invalid webhook payload", { status: 400 });
      }
      throw validationError;
    }

    // Verify signature - only skip if explicitly disabled AND not in production
    const isProduction = process.env.NODE_ENV === "production";
    const skipVerification = process.env.SKIP_WEBHOOK_VERIFICATION === "true" && !isProduction;
    const authToken = await twilioAutomationService.getAuthToken(orgId);

    if (process.env.SKIP_WEBHOOK_VERIFICATION === "true" && isProduction) {
      logger.error("[TwilioWebhook] SKIP_WEBHOOK_VERIFICATION ignored in production", { orgId });
    }

    if (skipVerification) {
      logger.warn("[TwilioWebhook] Signature validation disabled (non-production)", { orgId });
    } else if (!authToken) {
      logger.error("[TwilioWebhook] No auth token configured - rejecting webhook", { orgId });
      return new NextResponse("Webhook not configured", { status: 500 });
    } else {
      const signature = request.headers.get("X-Twilio-Signature") || "";
      const url = request.url;

      const isValid = await verifyTwilioSignature(
        authToken,
        signature,
        url,
        webhookData,
      );

      if (!isValid) {
        logger.warn("[TwilioWebhook] Signature validation failed", { orgId });
        return new NextResponse("Invalid signature", { status: 401 });
      }
    }

    // Check for duplicate messages (replay attack prevention)
    const idempotencyKey = `twilio:${event.MessageSid}`;
    if (await isAlreadyProcessed(idempotencyKey)) {
      logger.info("[TwilioWebhook] Duplicate message, skipping", {
        orgId,
        messageSid: event.MessageSid,
      });
      return new NextResponse(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        {
          status: 200,
          headers: {
            "Content-Type": "application/xml",
          },
        },
      );
    }

    // Log the event
    logger.info("[TwilioWebhook] Received SMS", {
      orgId,
      messageSid: event.MessageSid,
      from: event.From,
      to: event.To,
      hasBody: !!event.Body,
      numMedia: event.NumMedia,
    });

    // Process the incoming message
    await handleIncomingMessage(orgId, event);

    // Mark message as processed after successful handling
    await markAsProcessed(idempotencyKey, "twilio");

    // Return TwiML response (empty response acknowledges receipt)
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
        },
      },
    );
  } catch (error) {
    logger.error("[TwilioWebhook] Error processing webhook", {
      orgId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return new NextResponse("Internal server error", { status: 500 });
  }
}

// Export POST handler with rate limiting (100 requests/min per IP)
// Uses AGGRESSIVE preset for webhook endpoints
export const POST = withRateLimit(handleTwilioWebhook, RateLimitPresets.AGGRESSIVE);

/**
 * Handle incoming SMS message from Twilio
 */
async function handleIncomingMessage(
  orgId: string,
  event: TwilioWebhookEvent,
): Promise<void> {
  const { messageRouterService } = await import("@/lib/services/message-router");

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

  // Route to agent
  const routeResult = await messageRouterService.routeIncomingMessage(messageContext);

  if (!routeResult.success || !routeResult.agentId || !routeResult.organizationId) {
    logger.warn("[TwilioWebhook] Failed to route message", {
      orgId,
      from,
      to,
      error: routeResult.error,
    });
    return;
  }

  // Process the message with the agent
  const agentResponse = await messageRouterService.processWithAgent(
    routeResult.agentId,
    routeResult.organizationId,
    {
      from,
      to,
      body: body || "",
      provider: "twilio",
      providerMessageId: event.MessageSid,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      messageType: mediaUrls.length > 0 ? "mms" : "sms",
    },
  );

  if (agentResponse) {
    // Send the response back via Twilio
    const sent = await messageRouterService.sendMessage({
      to: from, // Reply to sender
      from: to, // From our number
      body: agentResponse.text,
      provider: "twilio",
      mediaUrls: agentResponse.mediaUrls,
      organizationId: routeResult.organizationId,
    });

    const responseTime = Date.now() - startTime;

    if (sent) {
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

// Health check endpoint for the webhook
// Returns minimal info to avoid exposing configuration status
export async function GET(): Promise<NextResponse> {
  // Don't expose org-specific configuration status as it could be used for reconnaissance
  // Just confirm the endpoint exists and is responding
  return NextResponse.json({
    status: "ok",
    service: "twilio-webhook",
  });
}
