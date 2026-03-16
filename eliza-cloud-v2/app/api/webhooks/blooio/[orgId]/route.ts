/**
 * Blooio Webhook Handler
 *
 * Receives inbound iMessage/SMS messages from Blooio and routes them
 * to the appropriate agent for processing.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { verifyBlooioSignature, parseBlooioWebhookEvent, extractBlooioMediaUrls, markChatAsRead, type BlooioWebhookEvent } from "@/lib/utils/blooio-api";
import { ZodError } from "zod";
import { RateLimitPresets, withRateLimit } from "@/lib/middleware/rate-limit";
import { isAlreadyProcessed, markAsProcessed } from "@/lib/utils/idempotency";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

async function handleBlooioWebhook(
  request: NextRequest,
  context?: { params: Promise<RouteParams["params"]> },
): Promise<Response> {
  const { orgId } = context?.params ? await context.params : { orgId: "" };

  if (!orgId) {
    return NextResponse.json(
      { error: "Organization ID is required" },
      { status: 400 },
    );
  }

  try {
    // Get raw body for signature verification
    const rawBody = await request.text();

    // Verify signature - only skip if explicitly disabled AND not in production
    const isProduction = process.env.NODE_ENV === "production";
    const skipVerification = process.env.SKIP_WEBHOOK_VERIFICATION === "true" && !isProduction;
    const webhookSecret =
      await blooioAutomationService.getWebhookSecret(orgId);

    if (process.env.SKIP_WEBHOOK_VERIFICATION === "true" && isProduction) {
      logger.error("[BlooioWebhook] SKIP_WEBHOOK_VERIFICATION ignored in production", { orgId });
    }

    if (skipVerification) {
      logger.warn("[BlooioWebhook] Signature validation disabled (non-production)", { orgId });
    } else if (!webhookSecret) {
      logger.error("[BlooioWebhook] No webhook secret configured - rejecting webhook", { orgId });
      return NextResponse.json(
        { error: "Webhook not configured" },
        { status: 500 },
      );
    } else {
      const signatureHeader = request.headers.get("X-Blooio-Signature") || "";
      const isValid = await verifyBlooioSignature(
        webhookSecret,
        signatureHeader,
        rawBody,
      );

      if (!isValid) {
        logger.warn("[BlooioWebhook] Signature validation failed", { orgId });
        return NextResponse.json(
          { error: "Invalid webhook signature" },
          { status: 401 },
        );
      }
    }

    // Parse and validate the webhook payload using Zod schema
    let payload: BlooioWebhookEvent;
    try {
      const rawPayload = JSON.parse(rawBody);
      payload = parseBlooioWebhookEvent(rawPayload);
    } catch (parseError) {
      if (parseError instanceof SyntaxError) {
        logger.warn("[BlooioWebhook] Invalid JSON payload", { orgId });
        return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (parseError instanceof ZodError) {
        logger.warn("[BlooioWebhook] Invalid webhook payload schema", {
          orgId,
          errors: parseError.issues.map((e) => ({
            path: e.path,
            message: e.message,
          })),
        });
        return NextResponse.json(
          { error: "Invalid webhook payload", details: parseError.issues },
          { status: 400 },
        );
      }
      throw parseError;
    }

    // Check for duplicate messages (replay attack prevention)
    // Only perform idempotency check if message_id is present to avoid key collision
    if (payload.message_id) {
      const idempotencyKey = `blooio:${payload.message_id}`;
      if (await isAlreadyProcessed(idempotencyKey)) {
        logger.info("[BlooioWebhook] Duplicate message, skipping", {
          orgId,
          messageId: payload.message_id,
        });
        return NextResponse.json({ success: true, status: "already_processed" });
      }
    } else {
      logger.warn("[BlooioWebhook] No message_id in payload, skipping idempotency check", { orgId });
    }

    // Log the event
    logger.info("[BlooioWebhook] Received event", {
      orgId,
      event: payload.event,
      messageId: payload.message_id,
      sender: payload.sender,
    });

    // Handle different event types
    switch (payload.event) {
      case "message.received":
        await handleIncomingMessage(orgId, payload);
        break;

      case "message.sent":
        logger.info("[BlooioWebhook] Message sent confirmation", {
          orgId,
          messageId: payload.message_id,
        });
        break;

      case "message.delivered":
        logger.info("[BlooioWebhook] Message delivered", {
          orgId,
          messageId: payload.message_id,
        });
        break;

      case "message.failed":
        logger.error("[BlooioWebhook] Message delivery failed", {
          orgId,
          messageId: payload.message_id,
        });
        break;

      case "message.read":
        logger.info("[BlooioWebhook] Message read", {
          orgId,
          messageId: payload.message_id,
        });
        break;

      default:
        logger.info("[BlooioWebhook] Unhandled event type", {
          orgId,
          event: payload.event,
        });
    }

    // Mark message as processed after successful handling (only if we have a message_id)
    if (payload.message_id) {
      await markAsProcessed(`blooio:${payload.message_id}`, "blooio");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[BlooioWebhook] Error processing webhook", {
      orgId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// Export POST handler with rate limiting (100 requests/min per IP)
// Uses AGGRESSIVE preset for webhook endpoints
export const POST = withRateLimit(handleBlooioWebhook, RateLimitPresets.AGGRESSIVE);

/**
 * Handle incoming message from Blooio
 */
async function handleIncomingMessage(
  orgId: string,
  event: BlooioWebhookEvent,
): Promise<void> {
  const { messageRouterService } = await import("@/lib/services/message-router");

  const chatId = event.external_id || event.sender;

  if (!chatId) {
    logger.warn("[BlooioWebhook] Message missing chat identifier", { orgId });
    return;
  }

  const text = event.text?.trim();
  const hasAttachments = event.attachments && event.attachments.length > 0;

  if (!text && !hasAttachments) {
    logger.info("[BlooioWebhook] Skipping empty message", { orgId, chatId });
    return;
  }

  // Get the Blooio API key and phone number for this organization
  const [apiKey, blooioFromNumber] = await Promise.all([
    blooioAutomationService.getApiKey(orgId),
    blooioAutomationService.getFromNumber(orgId),
  ]);

  if (!blooioFromNumber) {
    logger.warn("[BlooioWebhook] No Blooio phone number configured for org", { orgId });
  }

  // Mark the chat as read immediately for better UX (sends read receipt)
  if (apiKey && event.sender) {
    markChatAsRead(apiKey, event.sender, { fromNumber: blooioFromNumber || undefined })
      .catch((err) => logger.warn("[BlooioWebhook] Failed to mark chat as read", {
        orgId,
        chatId,
        error: err instanceof Error ? err.message : String(err),
      }));
  }

  logger.info("[BlooioWebhook] Processing incoming message", {
    orgId,
    chatId,
    sender: event.sender,
    recipient: blooioFromNumber,
    hasText: !!text,
    hasAttachments,
    protocol: event.protocol,
  });

  // Use the configured Blooio phone number as the recipient (the number that received the message)
  // Fall back to external_id only if no from number is configured
  const recipient = blooioFromNumber || event.external_id || chatId;
  
  // Extract and validate media URLs from attachments (prevents SSRF)
  const extractedMediaUrls = extractBlooioMediaUrls(event.attachments);

  // Build message context for routing
  const messageContext = {
    from: event.sender,
    to: recipient,
    body: text || "",
    provider: "blooio" as const,
    providerMessageId: event.message_id,
    mediaUrls: extractedMediaUrls,
    messageType: "imessage" as const,
    metadata: {
      protocol: event.protocol,
      external_id: event.external_id,
      timestamp: event.timestamp,
    },
  };

  // Route to agent
  // TODO: Agent routing will be added in next feature
  // Each user will have RLS isolation with a shared Eliza agent
  const routeResult = await messageRouterService.routeIncomingMessage(messageContext);

  if (!routeResult.success || !routeResult.agentId || !routeResult.organizationId) {
    logger.info("[BlooioWebhook] Message received (agent routing not configured)", {
      orgId,
      from: event.sender,
      text: text?.substring(0, 50),
    });
    return;
  }

  // Process the message with the agent
  const agentResponse = await messageRouterService.processWithAgent(
    routeResult.agentId,
    routeResult.organizationId,
    {
      from: event.sender,
      to: recipient,
      body: text || "",
      provider: "blooio",
      providerMessageId: event.message_id,
      mediaUrls: extractedMediaUrls,
      messageType: "imessage",
    },
  );

  if (agentResponse) {
    // Send the response back via Blooio
    const sent = await messageRouterService.sendMessage({
      to: event.sender,
      from: recipient,
      body: agentResponse.text,
      provider: "blooio",
      mediaUrls: agentResponse.mediaUrls,
      organizationId: routeResult.organizationId,
    });

    if (sent) {
      logger.info("[BlooioWebhook] Agent response sent", { orgId, chatId });
    } else {
      logger.error("[BlooioWebhook] Failed to send agent response", { orgId, chatId });
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
    service: "blooio-webhook",
  });
}
