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
  isPhoneSchemaMigrationRequired,
  phoneErrorDiagnostic,
} from "@/lib/services/phone-error-diagnostics";
import {
  type AuthenticatedBlueBubblesGateway,
  authenticateBlueBubblesGateway,
  registerPhoneGatewayDevice,
  touchBlueBubblesGateway,
} from "@/lib/services/phone-gateway-devices";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

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
    c.req.param("bridgeId") ??
    readEnvString(c, "BLUEBUBBLES_BRIDGE_ID") ??
    c.req.header("x-eliza-bridge") ??
    c.req.query("bridge") ??
    c.req.param("orgId") ??
    "default";

  let authorization: Awaited<ReturnType<typeof resolveGatewayAuthorization>>;
  try {
    authorization = await resolveGatewayAuthorization(c, bridgeId);
  } catch (error) {
    // error-policy:J2 database-backed authentication must fail explicitly and
    // retryably; a missing migration or read outage must never become a 401.
    logger.error("[BlueBubblesWebhook] Gateway authorization unavailable", {
      registeredGateway: false,
      ...phoneErrorDiagnostic(error),
    });
    return c.json(
      {
        success: false,
        handled: false,
        reason: "bridge_failed",
        routingError: "BlueBubbles gateway authorization unavailable",
      },
      503,
    );
  }
  if (!authorization) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const registeredGateway = authorization.gateway;

  const parsed = BlueBubblesWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid BlueBubbles payload" }, 400);
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
    });
    return c.json({ error: "Missing sender" }, 400);
  }

  const body = data.text?.trim() ?? "";
  const hasAttachments = Boolean(data.attachments?.length);
  if (!body && !hasAttachments) {
    return c.json({ success: true, skipped: "empty_message" });
  }

  const legacyOrganizationId = readEnvString(c, "BLUEBUBBLES_GATEWAY_ORG_ID");
  const legacyRecipient = readEnvString(c, "BLUEBUBBLES_GATEWAY_PHONE_NUMBER");
  if (!registeredGateway && (!legacyOrganizationId || !legacyRecipient)) {
    logger.error(
      "[BlueBubblesWebhook] Legacy gateway identity is not configured",
      { registeredGateway: false },
    );
    return c.json({ error: "BlueBubbles gateway is not configured" }, 503);
  }

  if (registeredGateway) {
    try {
      await touchBlueBubblesGateway(registeredGateway.id);
    } catch (error) {
      // error-policy:J1 a failed presence write is translated before the dedupe
      // claim, so the relay can retry without losing this message GUID.
      logger.error("[BlueBubblesWebhook] Gateway presence update failed", {
        registeredGateway: true,
        ...phoneErrorDiagnostic(error),
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
        type,
      });
      return c.json({ success: true, skipped: "duplicate_delivery" });
    }
  }

  const organizationId =
    registeredGateway?.organizationId ?? legacyOrganizationId!;
  const configuredRecipient = registeredGateway?.phoneNumber ?? legacyRecipient;
  const recipient = configuredRecipient!;
  const phoneAccountId = registeredGateway
    ? registeredGateway.phoneNumber
    : recipient;
  const phoneAccountLabel = registeredGateway
    ? (registeredGateway.friendlyName ?? registeredGateway.phoneNumber)
    : recipient;
  let gatewayDevice = {
    id: registeredGateway?.id ?? (null as string | null),
    registered: Boolean(registeredGateway),
  };

  try {
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
            ...(data.chats?.[0]?.guid !== null &&
            data.chats?.[0]?.guid !== undefined
              ? { chatGuid: data.chats[0].guid }
              : {}),
            ...(data.chats?.[0]?.chatIdentifier !== null &&
            data.chats?.[0]?.chatIdentifier !== undefined
              ? { chatIdentifier: data.chats[0].chatIdentifier }
              : {}),
            ...(data.handle?.service !== null &&
            data.handle?.service !== undefined
              ? { detectedService: data.handle.service }
              : {}),
          },
        });
      } catch (error) {
        // error-policy:J2 a missing canonical gateway table must reach the
        // retryable webhook boundary instead of masquerading as write_failed.
        if (isPhoneSchemaMigrationRequired(error)) throw error;
        // error-policy:J4 legacy device discovery may otherwise degrade without
        // affecting routing; an explicit write_failed result follows this path too.
        logger.warn("[BlueBubblesWebhook] Gateway device registration failed", {
          registeredGateway: false,
          ...phoneErrorDiagnostic(error),
        });
      }
    }

    const routingInput = {
      organizationId,
      from: sender,
      to: recipient,
      body,
      providerMessageId: data.guid ?? undefined,
      metadata: {
        bluebubblesBridgeId: bridgeId,
        bluebubblesEventType: type,
        ...(data.chats?.[0]?.guid !== null &&
        data.chats?.[0]?.guid !== undefined
          ? { bluebubblesChatGuid: data.chats[0].guid }
          : {}),
        ...(data.chats?.[0]?.chatIdentifier !== null &&
        data.chats?.[0]?.chatIdentifier !== undefined
          ? { bluebubblesChatIdentifier: data.chats[0].chatIdentifier }
          : {}),
        ...(data.dateCreated !== null && data.dateCreated !== undefined
          ? { bluebubblesDateCreated: data.dateCreated }
          : {}),
        localPhoneNumber: recipient,
        phoneNumber: recipient,
        phoneAccountId,
        phoneAccountLabel,
        ...(gatewayDevice.id !== null && gatewayDevice.id !== undefined
          ? { phoneGatewayDeviceId: gatewayDevice.id }
          : {}),
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
      type,
      registeredGateway: Boolean(registeredGateway),
      ...phoneErrorDiagnostic(error),
    });
    if (dedupeEventId) {
      // The marker is created before routing so concurrent deliveries cannot
      // double-spend. Remove it when routing fails so BlueBubbles or the local
      // relay can retry the same message guid instead of losing the message.
      try {
        await webhookEventsRepository.deleteByEventId(
          dedupeEventId,
          "bluebubbles",
        );
      } catch (cleanupError) {
        // error-policy:J6 dedupe rollback is best-effort; the original routing
        // failure must still return 503 so the transport observes a retryable
        // failure rather than an unstructured exception.
        logger.error("[BlueBubblesWebhook] Dedupe rollback failed", {
          type,
          ...phoneErrorDiagnostic(cleanupError),
        });
      }
    }
    return c.json(
      {
        success: false,
        handled: false,
        reason: "bridge_failed",
        gatewayDeviceId: gatewayDevice.id,
        gatewayDeviceRegistered: gatewayDevice.registered,
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
