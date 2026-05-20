/**
 * Local BlueBubbles bridge webhook.
 *
 * This endpoint is for a Mac-hosted BlueBubbles relay. The local relay forwards
 * inbound iMessage/SMS events here, Cloud decides the routing/reply, and the
 * relay sends the returned reply through the local BlueBubbles server.
 */

import { Hono } from "hono";
import { z } from "zod";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import { registerPhoneGatewayDevice } from "@/lib/services/phone-gateway-devices";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_GATEWAY_ORG_ID = "00000000-0000-4000-8000-000000000000";
const DEFAULT_GATEWAY_PHONE_NUMBER = "+14159611510";
const FIRST_CONTACT_REPLY =
  "Hey, I'm Eliza. I set up private Eliza Cloud agents that can text, remember context, and work for you. Eliza Cloud is usage-based: your agent runs in a private cloud container and spends credits only as it works. New users get $5 free credit to try it. What should I call you?";

const BlueBubblesHandleSchema = z
  .object({
    address: z.string().optional().nullable(),
    service: z.string().optional().nullable(),
  })
  .passthrough();

const BlueBubblesChatSchema = z
  .object({
    guid: z.string().optional().nullable(),
    chatIdentifier: z.string().optional().nullable(),
  })
  .passthrough();

const BlueBubblesMessageSchema = z
  .object({
    guid: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
    isFromMe: z.boolean().optional().nullable(),
    handle: BlueBubblesHandleSchema.optional().nullable(),
    chats: z.array(BlueBubblesChatSchema).optional().nullable(),
    attachments: z.array(z.unknown()).optional().nullable(),
    dateCreated: z.number().optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .passthrough();

const BlueBubblesWebhookSchema = z
  .object({
    type: z.string().min(1),
    data: BlueBubblesMessageSchema,
  })
  .passthrough();

function readEnvString(c: AppContext, key: string): string | null {
  const value = c.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPayloadString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authorized(c: AppContext): boolean {
  const expected =
    readEnvString(c, "BLUEBUBBLES_GATEWAY_SECRET") ??
    readEnvString(c, "GATEWAY_INTERNAL_SECRET");
  if (!expected) return false;

  const provided =
    c.req.header("x-eliza-gateway-secret") ??
    c.req.header("x-bluebubbles-gateway-secret") ??
    "";
  return provided === expected;
}

function resolveSender(
  data: z.infer<typeof BlueBubblesMessageSchema>,
): string | null {
  const handleAddress = data.handle?.address?.trim();
  if (handleAddress) return handleAddress;

  const chatIdentifier = data.chats?.[0]?.chatIdentifier?.trim();
  if (chatIdentifier) return chatIdentifier;

  return null;
}

function hasPreferredNameSignal(text: string): boolean {
  return /\b(?:my name is|i am|i'm|call me)\s+[a-z][a-z .'-]{1,40}\b/i.test(
    text,
  );
}

export async function handleBlueBubblesWebhook(
  c: AppContext,
): Promise<Response> {
  return handleBlueBubblesWebhookPayload(
    c,
    await c.req.json().catch(() => null),
  );
}

export async function handleBlueBubblesWebhookPayload(
  c: AppContext,
  payload: unknown,
): Promise<Response> {
  const bridgeId =
    readEnvString(c, "BLUEBUBBLES_BRIDGE_ID") ??
    c.req.param("bridgeId") ??
    c.req.header("x-eliza-bridge") ??
    c.req.query("bridge") ??
    c.req.param("orgId") ??
    "default";

  if (!authorized(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const parsed = BlueBubblesWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid BlueBubbles payload", details: parsed.error.issues },
      400,
    );
  }

  const { type, data } = parsed.data;
  if (data.isFromMe) {
    return c.json({ success: true, skipped: "outbound_message" });
  }

  if (
    type !== "new-message" &&
    type !== "message.created" &&
    type !== "message.received"
  ) {
    return c.json({ success: true, skipped: "unsupported_event", type });
  }

  const sender = resolveSender(data);
  if (!sender) {
    logger.warn("[BlueBubblesWebhook] Missing sender", {
      type,
      messageId: data.guid,
    });
    return c.json({ error: "Missing sender" }, 400);
  }

  const body = data.text?.trim() ?? "";
  const hasAttachments = Boolean(data.attachments?.length);
  if (!body && !hasAttachments) {
    return c.json({ success: true, skipped: "empty_message" });
  }

  const organizationId =
    readEnvString(c, "BLUEBUBBLES_GATEWAY_ORG_ID") ?? DEFAULT_GATEWAY_ORG_ID;
  const configuredRecipient = readEnvString(
    c,
    "BLUEBUBBLES_GATEWAY_PHONE_NUMBER",
  );
  const recipient =
    configuredRecipient ??
    readPayloadString(data.metadata, "localPhoneNumber") ??
    readPayloadString(data.metadata, "phoneNumber") ??
    DEFAULT_GATEWAY_PHONE_NUMBER;
  const phoneAccountId = configuredRecipient
    ? recipient
    : (readPayloadString(data.metadata, "phoneAccountId") ?? recipient);
  const phoneAccountLabel = configuredRecipient
    ? recipient
    : (readPayloadString(data.metadata, "phoneAccountLabel") ?? recipient);
  let gatewayDevice = {
    id: null as string | null,
    registered: false,
  };

  try {
    gatewayDevice = await registerPhoneGatewayDevice({
      organizationId,
      provider: "blooio",
      phoneNumber: recipient,
      bridgeId,
      phoneAccountId,
      phoneAccountLabel,
      friendlyName: phoneAccountLabel,
      sendMethod: "bluebubbles-local-bridge",
      cloudWebhookUrl: c.req.url,
      metadata: {
        eventType: type,
        chatGuid: data.chats?.[0]?.guid ?? undefined,
        chatIdentifier: data.chats?.[0]?.chatIdentifier ?? undefined,
        detectedService: data.handle?.service ?? undefined,
      },
    });
  } catch (error) {
    logger.warn("[BlueBubblesWebhook] Gateway device registration failed", {
      bridgeId,
      recipient,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const routed = await agentGatewayRouterService.routePhoneMessage({
      organizationId,
      provider: "blooio",
      from: sender,
      to: recipient,
      body,
      providerMessageId: data.guid ?? undefined,
      metadata: {
        bluebubblesBridgeId: bridgeId,
        bluebubblesEventType: type,
        bluebubblesChatGuid: data.chats?.[0]?.guid ?? undefined,
        bluebubblesChatIdentifier: data.chats?.[0]?.chatIdentifier ?? undefined,
        bluebubblesDateCreated: data.dateCreated ?? undefined,
        localPhoneNumber: recipient,
        phoneNumber: recipient,
        phoneAccountId,
        phoneAccountLabel,
        phoneGatewayDeviceId: gatewayDevice.id ?? undefined,
        phoneGatewayDeviceRegistered: gatewayDevice.registered,
      },
    });

    const replyText =
      routed.reason === "unknown_owner" && !hasPreferredNameSignal(body)
        ? FIRST_CONTACT_REPLY
        : (routed.replyText ?? null);

    return c.json({
      success: true,
      handled: routed.handled,
      reason: routed.reason,
      replyText,
      agentId: routed.agentId,
      organizationId: routed.organizationId,
      userId: routed.userId,
      gatewayDeviceId: gatewayDevice.id,
      gatewayDeviceRegistered: gatewayDevice.registered,
      gatewayDevicePhoneNumber: recipient,
      gatewayDeviceBridgeId: bridgeId,
      gatewayDeviceProvider: "blooio",
    });
  } catch (error) {
    logger.error("[BlueBubblesWebhook] Routing failed", {
      bridgeId,
      type,
      messageId: data.guid,
      sender,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({
      success: true,
      handled: true,
      reason: "bridge_failed",
      replyText: FIRST_CONTACT_REPLY,
      gatewayDeviceId: gatewayDevice.id,
      gatewayDeviceRegistered: gatewayDevice.registered,
      gatewayDevicePhoneNumber: recipient,
      gatewayDeviceBridgeId: bridgeId,
      gatewayDeviceProvider: "blooio",
      routingError: "BlueBubbles routing failed",
    });
  }
}

const app = new Hono<AppEnv>();
app.post("/", (c) => handleBlueBubblesWebhook(c));
app.get("/", (c) => c.json({ status: "ok", service: "bluebubbles-webhook" }));

export default app;
