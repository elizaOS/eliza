/**
 * Blooio Webhook Handler
 *
 * Receives inbound iMessage/SMS messages from Blooio and routes them
 * to the appropriate agent for processing.
 */

import { Hono } from "hono";
import { ZodError } from "zod";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import {
  type BlooioWebhookEvent,
  extractBlooioMediaUrls,
  markChatAsRead,
  parseBlooioWebhookEvent,
  verifyBlooioSignature,
} from "@/lib/utils/blooio-api";
import { isAlreadyProcessed, markAsProcessed } from "@/lib/utils/idempotency";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

async function handleBlooioWebhook(c: AppContext): Promise<Response> {
  const orgId = c.req.param("orgId") ?? "";
  if (!orgId) return c.json({ error: "Organization ID is required" }, 400);

  try {
    const rawBody = await c.req.text();

    const isProduction = c.env.NODE_ENV === "production";
    const skipVerification = c.env.SKIP_WEBHOOK_VERIFICATION === "true" && !isProduction;
    const webhookSecret = await blooioAutomationService.getWebhookSecret(orgId);

    if (c.env.SKIP_WEBHOOK_VERIFICATION === "true" && isProduction) {
      logger.error("[BlooioWebhook] SKIP_WEBHOOK_VERIFICATION ignored in production", { orgId });
    }

    if (skipVerification) {
      logger.warn("[BlooioWebhook] Signature validation disabled (non-production)", { orgId });
    } else if (!webhookSecret) {
      logger.error("[BlooioWebhook] No webhook secret configured - rejecting webhook", { orgId });
      return c.json({ error: "Webhook not configured" }, 500);
    } else {
      const signatureHeader = c.req.header("X-Blooio-Signature") || "";
      const isValid = await verifyBlooioSignature(webhookSecret, signatureHeader, rawBody);
      if (!isValid) {
        logger.warn("[BlooioWebhook] Signature validation failed", { orgId });
        return c.json({ error: "Invalid webhook signature" }, 401);
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
        return c.json({ error: "Invalid JSON payload" }, 400);
      }
      if (parseError instanceof ZodError) {
        logger.warn("[BlooioWebhook] Invalid webhook payload schema", {
          orgId,
          errors: parseError.issues.map((e) => ({ path: e.path, message: e.message })),
        });
        return c.json({ error: "Invalid webhook payload", details: parseError.issues }, 400);
      }
      throw parseError;
    }

    if (payload.message_id) {
      const idempotencyKey = `blooio:${payload.message_id}`;
      if (await isAlreadyProcessed(idempotencyKey)) {
        logger.info("[BlooioWebhook] Duplicate message, skipping", {
          orgId,
          messageId: payload.message_id,
        });
        return c.json({ success: true, status: "already_processed" });
      }
    } else {
      logger.warn("[BlooioWebhook] No message_id in payload, skipping idempotency check", {
        orgId,
      });
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

    return c.json({ success: true });
  } catch (error) {
    logger.error("[BlooioWebhook] Error processing webhook", {
      orgId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return c.json({ error: "Internal server error" }, 500);
  }
}

const app = new Hono<AppEnv>();
app.post("/", rateLimit(RateLimitPresets.AGGRESSIVE), (c) => handleBlooioWebhook(c));

/**
 * Handle incoming message from Blooio
 */
async function handleIncomingMessage(orgId: string, event: BlooioWebhookEvent): Promise<void> {
  const [{ messageRouterService }, { agentGatewayRouterService }] = await Promise.all([
    import("@/lib/services/message-router"),
    import("@/lib/services/agent-gateway-router"),
  ]);

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
    logger.warn("[BlooioWebhook] No Blooio phone number configured for org", {
      orgId,
    });
  }

  // Mark the chat as read immediately for better UX (sends read receipt)
  if (apiKey && event.sender) {
    markChatAsRead(apiKey, event.sender, {
      fromNumber: blooioFromNumber || undefined,
    }).catch((err) =>
      logger.warn("[BlooioWebhook] Failed to mark chat as read", {
        orgId,
        chatId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
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

  const sender = event.sender ?? undefined;
  if (!sender) {
    logger.warn("[BlooioWebhook] Missing sender in event payload", { orgId });
    return;
  }

  // Use the configured Blooio phone number as the recipient (the number that received the message)
  // Fall back to external_id only if no from number is configured
  const recipient = blooioFromNumber || event.external_id || chatId;
  if (!recipient) {
    logger.warn("[BlooioWebhook] Missing recipient in event payload", {
      orgId,
    });
    return;
  }

  // Extract and validate media URLs from attachments (prevents SSRF)
  const extractedMediaUrls = extractBlooioMediaUrls(event.attachments);

  // Build message context for routing
  const messageContext = {
    from: sender,
    to: recipient,
    body: text || "",
    provider: "blooio" as const,
    providerMessageId: event.message_id ?? undefined,
    mediaUrls: extractedMediaUrls,
    messageType: "imessage" as const,
    metadata: {
      protocol: event.protocol,
      external_id: event.external_id,
      timestamp: event.timestamp,
    },
  };

  const routed = await agentGatewayRouterService.routePhoneMessage({
    organizationId: orgId,
    provider: "blooio",
    from: sender,
    to: recipient,
    body: text || "",
    providerMessageId: event.message_id ?? undefined,
    mediaUrls: extractedMediaUrls,
    metadata: messageContext.metadata,
  });

  if (!routed.handled) {
    logger.info("[BlooioWebhook] Message did not resolve to an owned Agent", {
      orgId,
      from: sender,
      reason: routed.reason,
      agentId: routed.agentId,
    });
    return;
  }

  if (routed.replyText?.trim()) {
    // Send the response back via Blooio
    const sent = await messageRouterService.sendMessage({
      to: sender,
      from: recipient,
      body: routed.replyText.trim(),
      provider: "blooio",
      organizationId: orgId,
    });

    if (sent) {
      logger.info("[BlooioWebhook] Agent response sent", { orgId, chatId });
    } else {
      logger.error("[BlooioWebhook] Failed to send agent response", {
        orgId,
        chatId,
      });
    }
  }
}

app.get("/", (c) => c.json({ status: "ok", service: "blooio-webhook" }));

export default app;
