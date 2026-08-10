/**
 * Local BlueBubbles bridge webhook.
 *
 * This endpoint is for a Mac-hosted BlueBubbles relay. The local relay forwards
 * inbound iMessage/SMS events here, Cloud decides the routing/reply, and the
 * relay sends the returned reply through the local BlueBubbles server.
 */

import { Hono } from "hono";
import { z } from "zod";
import { webhookEventsRepository } from "@/db/repositories/webhook-events";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import {
  type AuthenticatedBlueBubblesGateway,
  authenticateBlueBubblesGateway,
  registerPhoneGatewayDevice,
  touchBlueBubblesGateway,
} from "@/lib/services/phone-gateway-devices";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_GATEWAY_ORG_ID = "00000000-0000-4000-8000-000000000000";
const DEFAULT_GATEWAY_PHONE_NUMBER = "+14159611510";

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

function legacyAuthorized(c: AppContext): boolean {
  const expected =
    readEnvString(c, "BLUEBUBBLES_GATEWAY_SECRET") ??
    readEnvString(c, "GATEWAY_INTERNAL_SECRET");
  if (!expected) return false;

  const provided =
    c.req.header("x-eliza-gateway-secret") ??
    c.req.header("x-bluebubbles-gateway-secret") ??
    "";
  // Constant-time: this public (session-auth-bypassing) webhook is gated solely
  // by this header secret, so a plain === would leak it byte-by-byte to a timing
  // attack and let an attacker forge state-mutating webhook payloads.
  return timingSafeEqualSecret(provided, expected);
}

function readGatewayToken(c: AppContext): string {
  const authorization = c.req.header("authorization") ?? "";
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return c.req.header("x-bluebubbles-gateway-token")?.trim() ?? "";
}

async function resolveGatewayAuthorization(
  c: AppContext,
  bridgeId: string,
): Promise<
  | { kind: "registered"; gateway: AuthenticatedBlueBubblesGateway }
  | { kind: "legacy"; gateway: null }
  | null
> {
  if (bridgeId.startsWith("bb-")) {
    const gateway = await authenticateBlueBubblesGateway(
      bridgeId,
      readGatewayToken(c),
    );
    return gateway ? { kind: "registered", gateway } : null;
  }
  return legacyAuthorized(c) ? { kind: "legacy", gateway: null } : null;
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

export async function handleBlueBubblesWebhook(
  c: AppContext,
): Promise<Response> {
  return handleBlueBubblesWebhookPayload(
    c,
    await c.req.json().catch(() => {
      // error-policy:J3 malformed webhook JSON is represented as invalid input.
      return null;
    }),
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

  const authorization = await resolveGatewayAuthorization(c, bridgeId);
  if (!authorization) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const registeredGateway = authorization.gateway;

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

  if (registeredGateway) {
    try {
      await touchBlueBubblesGateway(registeredGateway.id);
    } catch (error) {
      // error-policy:J1 a failed presence write is translated before the dedupe
      // claim, so the relay can retry without losing this message GUID.
      logger.error("[BlueBubblesWebhook] Gateway presence update failed", {
        bridgeId,
        messageId: data.guid,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          success: false,
          handled: false,
          reason: "bridge_failed",
          routingError: "BlueBubbles gateway presence update failed",
        },
        503,
      );
    }
  }

  // Replay dedupe on the message guid (matches the crypto/stripe webhooks).
  // The local relay retries deliveries, so without this a re-delivered message
  // is routed to the agent twice (duplicate reply + double credit spend).
  const messageGuid = data.guid?.trim() ?? null;
  const dedupeEventId = messageGuid
    ? `bluebubbles:${bridgeId}:${messageGuid}`
    : null;
  if (messageGuid) {
    const dedupe = await webhookEventsRepository.tryCreate({
      event_id: dedupeEventId!,
      provider: "bluebubbles",
      event_type: type,
      payload_hash: messageGuid,
    });
    if (!dedupe.created) {
      logger.warn("[BlueBubblesWebhook] Duplicate delivery ignored", {
        messageGuid,
        type,
      });
      return c.json({ success: true, skipped: "duplicate_delivery" });
    }
  }

  const organizationId =
    registeredGateway?.organizationId ??
    readEnvString(c, "BLUEBUBBLES_GATEWAY_ORG_ID") ??
    DEFAULT_GATEWAY_ORG_ID;
  const configuredRecipient = registeredGateway?.phoneNumber
    ? registeredGateway.phoneNumber
    : readEnvString(c, "BLUEBUBBLES_GATEWAY_PHONE_NUMBER");
  const recipient =
    configuredRecipient ??
    readPayloadString(data.metadata, "localPhoneNumber") ??
    readPayloadString(data.metadata, "phoneNumber") ??
    DEFAULT_GATEWAY_PHONE_NUMBER;
  const phoneAccountId = registeredGateway
    ? registeredGateway.phoneNumber
    : configuredRecipient
      ? recipient
      : (readPayloadString(data.metadata, "phoneAccountId") ?? recipient);
  const phoneAccountLabel = registeredGateway
    ? (registeredGateway.friendlyName ?? registeredGateway.phoneNumber)
    : configuredRecipient
      ? recipient
      : (readPayloadString(data.metadata, "phoneAccountLabel") ?? recipient);
  let gatewayDevice = {
    id: registeredGateway?.id ?? (null as string | null),
    registered: Boolean(registeredGateway),
  };

  if (!registeredGateway) {
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
      // error-policy:J4 legacy device discovery may degrade without affecting routing.
      logger.warn("[BlueBubblesWebhook] Gateway device registration failed", {
        bridgeId,
        recipient,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const routingInput = {
      organizationId,
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
    };
    let routed: Awaited<
      ReturnType<typeof agentGatewayRouterService.routePhoneMessage>
    >;
    if (registeredGateway?.routingMode === "fixed-agent") {
      if (!registeredGateway.agentId) {
        throw new Error(
          "Fixed-agent BlueBubbles registration is missing its agent id",
        );
      }
      routed =
        await agentGatewayRouterService.routeRegisteredBlueBubblesMessage({
          ...routingInput,
          userId: registeredGateway.userId,
          agentId: registeredGateway.agentId,
        });
    } else {
      routed = await agentGatewayRouterService.routePhoneMessage({
        ...routingInput,
        provider: "blooio",
      });
    }

    if (!routed.handled && routed.reason === "bridge_failed") {
      throw new Error("BlueBubbles agent bridge returned a retryable failure");
    }

    return c.json({
      success: true,
      handled: routed.handled,
      reason: routed.reason,
      replyText: routed.replyText ?? null,
      agentId: routed.agentId,
      organizationId: routed.organizationId,
      userId: routed.userId,
      gatewayDeviceId: gatewayDevice.id,
      gatewayDeviceRegistered: gatewayDevice.registered,
      gatewayDevicePhoneNumber: recipient,
      gatewayDeviceBridgeId: bridgeId,
      gatewayDeviceProvider: registeredGateway ? "bluebubbles" : "blooio",
      gatewayRoutingMode: registeredGateway?.routingMode ?? "sender-owned",
    });
  } catch (error) {
    // error-policy:J1 the webhook boundary returns an explicit transport failure.
    logger.error("[BlueBubblesWebhook] Routing failed", {
      bridgeId,
      type,
      messageId: data.guid,
      error: error instanceof Error ? error.message : String(error),
    });
    if (dedupeEventId) {
      // The marker is created before routing so concurrent deliveries cannot
      // double-spend. Remove it when routing fails so BlueBubbles or the local
      // relay can retry the same message guid instead of losing the message.
      await webhookEventsRepository.deleteByEventId(
        dedupeEventId,
        "bluebubbles",
      );
    }
    return c.json(
      {
        success: false,
        handled: false,
        reason: "bridge_failed",
        gatewayDeviceId: gatewayDevice.id,
        gatewayDeviceRegistered: gatewayDevice.registered,
        gatewayDevicePhoneNumber: recipient,
        gatewayDeviceBridgeId: bridgeId,
        gatewayDeviceProvider: registeredGateway ? "bluebubbles" : "blooio",
        routingError: "BlueBubbles routing failed",
      },
      503,
    );
  }
}

const app = new Hono<AppEnv>();
app.post("/", (c) => handleBlueBubblesWebhook(c));
app.get("/", (c) => c.json({ status: "ok", service: "bluebubbles-webhook" }));

export default app;
