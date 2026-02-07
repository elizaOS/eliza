/**
 * Eliza App - Public Blooio Webhook
 *
 * Receives iMessages from Blooio and routes them to the default Eliza agent.
 * Auto-provisions users on first message based on sender identifier:
 * - Phone number: Carrier-verified via iMessage delivery
 * - Apple ID email: User sends from their Apple ID instead of phone
 * Uses ASSISTANT mode for full multi-step action execution.
 *
 * Cross-platform: If user later does Telegram OAuth with same phone, accounts are linked.
 * Email-based accounts can also link phone via Telegram OAuth.
 *
 * POST /api/eliza-app/webhook/blooio
 */

import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "@/lib/utils/logger";
import { RateLimitPresets, withRateLimit } from "@/lib/middleware/rate-limit";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { roomsService } from "@/lib/services/agents/rooms";
import { isAlreadyProcessed, markAsProcessed } from "@/lib/utils/idempotency";
import { normalizePhoneNumber, isValidE164 } from "@/lib/utils/phone-normalization";
import { isValidEmail, normalizeEmail, maskEmailForLogging } from "@/lib/utils/email-validation";
import { generateElizaAppRoomId } from "@/lib/utils/deterministic-uuid";
import {
  verifyBlooioSignature,
  parseBlooioWebhookEvent,
  extractBlooioMediaUrls,
  blooioApiRequest,
  markChatAsRead,
  type BlooioWebhookEvent,
  type BlooioSendMessageResponse,
} from "@/lib/utils/blooio-api";
import { elizaAppConfig } from "@/lib/services/eliza-app/config";
import { runtimeFactory } from "@/lib/eliza/runtime-factory";
import { createMessageHandler } from "@/lib/eliza/message-handler";
import { userContextService } from "@/lib/eliza/user-context";
import { AgentMode } from "@/lib/eliza/agent-mode-types";
import { distributedLocks } from "@/lib/cache/distributed-locks";
import { v4 as uuidv4 } from "uuid";
import { ContentType } from "@elizaos/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // Extended for ASSISTANT mode multi-step execution

const { defaultAgentId: DEFAULT_AGENT_ID } = elizaAppConfig;
const { apiKey: BLOOIO_API_KEY, webhookSecret: WEBHOOK_SECRET, phoneNumber: BLOOIO_PHONE_NUMBER } = elizaAppConfig.blooio;

async function sendBlooioMessage(
  toPhone: string,
  text: string,
  mediaUrls?: string[],
): Promise<boolean> {
  try {
    const response = await blooioApiRequest<BlooioSendMessageResponse>(
      BLOOIO_API_KEY,
      "POST",
      `/chats/${encodeURIComponent(toPhone)}/messages`,
      {
        text,
        attachments: mediaUrls,
      },
      {
        fromNumber: BLOOIO_PHONE_NUMBER,
      },
    );

    logger.info("[ElizaApp BlooioWebhook] Message sent", {
      toPhone,
      messageId: response.message_id,
    });

    return true;
  } catch (error) {
    logger.error("[ElizaApp BlooioWebhook] Failed to send message", {
      toPhone,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function handleIncomingMessage(event: BlooioWebhookEvent): Promise<boolean> {
  if (!event.sender) return true; // Not applicable, mark as processed
  if (event.is_group) return true; // Not applicable, mark as processed

  // Mark the chat as read immediately for better UX (sends read receipt)
  markChatAsRead(BLOOIO_API_KEY, event.sender, { fromNumber: BLOOIO_PHONE_NUMBER })
    .catch((err) => logger.warn("[ElizaApp BlooioWebhook] Failed to mark chat as read", {
      sender: event.sender,
      error: err instanceof Error ? err.message : String(err),
    }));

  const text = event.text?.trim();
  const mediaUrls = extractBlooioMediaUrls(event.attachments);
  if (!text && mediaUrls.length === 0) return true; // Not applicable, mark as processed

  // Determine sender type: phone number or Apple ID email
  const senderRaw = event.sender.trim();
  const isEmailSender = senderRaw.includes("@");

  let userWithOrg: Awaited<ReturnType<typeof elizaAppUserService.findOrCreateByPhone>>["user"];
  let organization: Awaited<ReturnType<typeof elizaAppUserService.findOrCreateByPhone>>["organization"];
  let isNew: boolean;
  let senderIdentifier: string;

  if (isEmailSender) {
    // Apple ID email sender - auto-provision by email
    // Note: Email accounts can later link phone via Telegram OAuth for cross-platform
    const email = normalizeEmail(senderRaw);

    if (!isValidEmail(email)) {
      logger.warn("[ElizaApp BlooioWebhook] Invalid email format", {
        sender: maskEmailForLogging(senderRaw),
      });
      return true; // Mark as processed - invalid format
    }

    logger.info("[ElizaApp BlooioWebhook] Auto-provisioning user by email", {
      email: maskEmailForLogging(email),
    });
    const result = await elizaAppUserService.findOrCreateByEmail(email);
    userWithOrg = result.user;
    organization = result.organization;
    isNew = result.isNew;
    senderIdentifier = email;
    logger.info("[ElizaApp BlooioWebhook] User provisioned (email)", {
      userId: userWithOrg.id,
      organizationId: organization.id,
      isNewUser: isNew,
      email: maskEmailForLogging(email),
    });
  } else {
    // Phone number sender - auto-provision by phone (carrier-verified)
    const phoneNumber = normalizePhoneNumber(senderRaw);
    if (!isValidE164(phoneNumber)) {
      logger.warn("[ElizaApp BlooioWebhook] Invalid phone number format", {
        sender: senderRaw,
        normalized: phoneNumber,
      });
      return true; // Mark as processed - invalid format
    }

    logger.info("[ElizaApp BlooioWebhook] Auto-provisioning user by phone", {
      phoneNumber: `***${phoneNumber.slice(-4)}`
    });
    const result = await elizaAppUserService.findOrCreateByPhone(phoneNumber);
    userWithOrg = result.user;
    organization = result.organization;
    isNew = result.isNew;
    senderIdentifier = phoneNumber;
    logger.info("[ElizaApp BlooioWebhook] User provisioned (phone)", {
      userId: userWithOrg.id,
      organizationId: organization.id,
      isNewUser: isNew,
      phoneNumber: `***${phoneNumber.slice(-4)}`,
    });
  }

  const roomId = generateElizaAppRoomId("imessage", DEFAULT_AGENT_ID, senderIdentifier);
  const entityId = userWithOrg.id; // Use userId as entityId for unified memory

  const existingRoom = await roomsService.getRoomSummary(roomId);
  if (!existingRoom) {
    await roomsService.createRoom({
      id: roomId,
      agentId: DEFAULT_AGENT_ID,
      entityId,
      source: "blooio",
      type: "DM",
      name: `iMessage: ${senderIdentifier}`,
      metadata: {
        channel: "imessage",
        identifier: senderIdentifier,
        identifierType: isEmailSender ? "email" : "phone",
        userId: entityId,
        organizationId: organization.id,
      },
    });
  }
  // Always ensure participant exists (handles partial failures on retry)
  try {
    await roomsService.addParticipant(roomId, entityId, DEFAULT_AGENT_ID);
  } catch (error) {
    // Ignore "already exists" errors, re-throw others
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("already") && !msg.includes("duplicate") && !msg.includes("exists")) {
      throw error;
    }
  }

  let fullMessage = text || "";
  if (mediaUrls.length > 0) {
    fullMessage += `\n\n[Attached media: ${mediaUrls.join(", ")}]`;
  }

  // Acquire distributed lock to prevent concurrent message processing
  // TTL must be >= maxDuration (120s) to prevent lock expiry during processing
  const lock = await distributedLocks.acquireRoomLockWithRetry(roomId, 120000, {
    maxRetries: 10,
    initialDelayMs: 100,
    maxDelayMs: 2000,
  });

  if (!lock) {
    logger.error("[ElizaApp BlooioWebhook] Failed to acquire room lock", { roomId });
    return false; // Don't mark as processed - allow retry
  }

  try {
    const userContext = await userContextService.buildContext({
      user: { ...userWithOrg, organization } as never,
      isAnonymous: false,
      agentMode: AgentMode.ASSISTANT,
    });
    userContext.characterId = DEFAULT_AGENT_ID;
    userContext.webSearchEnabled = true;
    userContext.modelPreferences = elizaAppConfig.modelPreferences;

    logger.info("[ElizaApp BlooioWebhook] Processing message", {
      userId: entityId,
      roomId,
      mode: "assistant",
    });

    const runtime = await runtimeFactory.createRuntimeForUser(userContext);
    const messageHandler = createMessageHandler(runtime, userContext);

    const result = await messageHandler.process({
      roomId,
      text: fullMessage,
      attachments: mediaUrls.map((url) => ({
        id: uuidv4(),
        url,
        contentType: ContentType.IMAGE,
        title: "Attached image",
      })),
      agentModeConfig: { mode: AgentMode.ASSISTANT },
    });

    const responseContent = result.message.content;
    const responseText =
      typeof responseContent === "string"
        ? responseContent
        : responseContent?.text || "";

    if (responseText) {
      await sendBlooioMessage(senderIdentifier, responseText);
    }
    return true;
  } catch (error) {
    logger.error("[ElizaApp BlooioWebhook] Agent failed", {
      error: error instanceof Error ? error.message : String(error),
      roomId,
    });
    return true; // Processing attempted, mark as processed to avoid infinite retry
  } finally {
    await lock.release();
  }
}

async function handleBlooioWebhook(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const skipVerification =
    process.env.SKIP_WEBHOOK_VERIFICATION === "true" &&
    process.env.NODE_ENV !== "production";

  // Fail closed: require webhook secret unless explicitly skipped in dev
  if (!WEBHOOK_SECRET) {
    if (skipVerification) {
      logger.warn("[ElizaApp BlooioWebhook] Signature verification skipped (dev mode)");
    } else {
      logger.error("[ElizaApp BlooioWebhook] WEBHOOK_SECRET is required");
      return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
    }
  } else {
    const signatureHeader = request.headers.get("X-Blooio-Signature") || "";
    const isValid = await verifyBlooioSignature(WEBHOOK_SECRET, signatureHeader, rawBody);

    if (!isValid) {
      logger.warn("[ElizaApp BlooioWebhook] Invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: BlooioWebhookEvent;
  try {
    const rawPayload = JSON.parse(rawBody);
    payload = parseBlooioWebhookEvent(rawPayload);
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn("[ElizaApp BlooioWebhook] Invalid JSON payload");
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (error instanceof ZodError) {
      logger.warn("[ElizaApp BlooioWebhook] Invalid payload schema", {
        issues: error.issues,
      });
      return NextResponse.json(
        { error: "Invalid payload", details: error.issues },
        { status: 400 },
      );
    }
    throw error;
  }

  // Log every webhook event for debugging - show ALL fields to understand what Blooio sends
  logger.info("[ElizaApp BlooioWebhook] Received event", {
    event: payload.event,
    messageId: payload.message_id,
    sender: payload.sender || "none",
    external_id: payload.external_id || "none",
    internal_id: payload.internal_id || "none",
    protocol: payload.protocol || "none",
    hasText: !!payload.text,
    textPreview: payload.text?.slice(0, 20) || "none",
  });

  if (payload.message_id) {
    const idempotencyKey = `blooio:eliza-app:${payload.message_id}`;
    if (await isAlreadyProcessed(idempotencyKey)) {
      logger.info("[ElizaApp BlooioWebhook] Skipping duplicate", { messageId: payload.message_id });
      return NextResponse.json({ success: true, status: "already_processed" });
    }
  }

  let processed = true;
  if (payload.event === "message.received") {
    logger.info("[ElizaApp BlooioWebhook] Processing message.received", {
      sender: payload.sender,
      textLength: payload.text?.length || 0,
    });
    processed = await handleIncomingMessage(payload);
  } else if (payload.event === "message.failed") {
    logger.error("[ElizaApp BlooioWebhook] Delivery failed", { messageId: payload.message_id });
  } else {
    logger.info("[ElizaApp BlooioWebhook] Ignoring event type", { event: payload.event });
  }

  // Only mark as processed if handler succeeded (prevents lost messages on lock failure)
  if (processed && payload.message_id) {
    await markAsProcessed(`blooio:eliza-app:${payload.message_id}`, "blooio-eliza-app");
  }

  // Return 503 on lock failure to trigger webhook retry from Blooio
  if (!processed) {
    return NextResponse.json(
      { success: false, error: "Service temporarily unavailable" },
      { status: 503 }
    );
  }

  return NextResponse.json({ success: true });
}

export const POST = withRateLimit(handleBlooioWebhook, RateLimitPresets.AGGRESSIVE);

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "ok",
    service: "eliza-app-blooio-webhook",
    phoneNumber: BLOOIO_PHONE_NUMBER,
  });
}
