// Handles webhook gateway webhook handler behavior for authenticated connector fan-in.
import type {
  ChatEvent,
  Platform,
  PlatformAdapter,
  WebhookConfig,
} from "./adapters/types";
import { logger } from "./logger";
import type { GatewayRedis } from "./redis";
import {
  forwardToServer,
  refreshKedaActivity,
  resolveAgentServer,
  resolveIdentity,
} from "./server-router";
import { resolveWebhookConfig } from "./webhook-config";

const DEDUP_TTL_SECONDS = 300;
const PROCESSING_TTL_SECONDS = 60;
const TELEGRAM_DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const TELEGRAM_EGRESS_STARTED = "egress_started";
const TELEGRAM_DELIVERED = "delivered";

interface HandlerDeps {
  redis: GatewayRedis;
  cloudBaseUrl: string;
  getAuthHeader: () => { Authorization: string };
}

export async function handleWebhook(
  request: Request,
  adapter: PlatformAdapter,
  deps: HandlerDeps,
  project: string,
  agentId?: string,
): Promise<Response> {
  const { redis, cloudBaseUrl, getAuthHeader } = deps;
  const authHeader = getAuthHeader();

  const rawBody = await request.text();

  // ── Synchronous phase: verify + extract + dedup (fast, <100ms) ──

  const config = await resolveWebhookConfig(
    redis,
    cloudBaseUrl,
    authHeader,
    adapter.platform,
    project,
    agentId,
  );
  if (!config) {
    logger.warn("No webhook config found", {
      project,
      platform: adapter.platform,
      agentId,
    });
    return new Response(JSON.stringify({ error: "not configured" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const valid = await adapter.verifyWebhook(request, rawBody, config);
  if (!valid) {
    logger.warn("Webhook signature verification failed", {
      platform: adapter.platform,
    });
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = await adapter.extractEvent(rawBody);
  if (!event) {
    return ackResponse(adapter.platform);
  }

  const dedupKey = buildWebhookDedupeKey(
    adapter,
    config,
    event,
    project,
    agentId,
  );
  const priorDeliveryState = await redis.get<string>(dedupKey);
  if (priorDeliveryState) {
    if (
      adapter.platform === "telegram" &&
      priorDeliveryState === TELEGRAM_EGRESS_STARTED
    ) {
      logger.error(
        "Telegram webhook delivery outcome is uncertain; refusing replay",
        {
          platform: adapter.platform,
          messageId: event.messageId,
          dedupKey,
        },
      );
      return new Response(
        JSON.stringify({ error: "delivery outcome uncertain" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    logger.debug("Duplicate webhook skipped", {
      platform: adapter.platform,
      messageId: event.messageId,
      dedupKey,
    });
    return ackResponse(adapter.platform);
  }

  if (adapter.platform === "telegram") {
    const processingKey = `${dedupKey}:processing`;
    const claimed = await redis.set(processingKey, "1", {
      nx: true,
      ex: PROCESSING_TTL_SECONDS,
    });
    if (!claimed) {
      return new Response(JSON.stringify({ error: "update in progress" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      await processMessage(
        adapter,
        config,
        event,
        deps,
        project,
        agentId,
        async () => {
          // Write the no-replay barrier before the Bot API call. A crash or
          // ambiguous network failure after this point must fail visibly on a
          // Telegram retry instead of sending the same response twice.
          await redis.set(dedupKey, TELEGRAM_EGRESS_STARTED, {
            ex: TELEGRAM_DELIVERY_TTL_SECONDS,
          });
        },
      );
      await redis.set(dedupKey, TELEGRAM_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
      return ackResponse(adapter.platform);
    } finally {
      await redis.del(processingKey);
    }
  }

  const isNew = await redis.set(dedupKey, "1", {
    nx: true,
    ex: DEDUP_TTL_SECONDS,
  });
  if (!isNew) {
    logger.debug("Duplicate webhook skipped", {
      platform: adapter.platform,
      messageId: event.messageId,
      dedupKey,
    });
    return ackResponse(adapter.platform);
  }

  // ── Async phase: identity → forward → reply (runs in background) ──

  processMessage(adapter, config, event, deps, project, agentId).catch(
    (err) => {
      logger.error("Background message processing failed", {
        error: err instanceof Error ? err.message : String(err),
        project,
        platform: adapter.platform,
        messageId: event.messageId,
      });
    },
  );

  return ackResponse(adapter.platform);
}

function buildWebhookDedupeKey(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  project: string,
  agentId?: string,
): string {
  const scope = adapter.getDedupeScope?.(config, event, project, agentId);
  return scope
    ? `webhook:${adapter.platform}:${scope}:message:${event.messageId}`
    : `webhook:${adapter.platform}:${event.messageId}`;
}

async function processMessage(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  explicitAgentId?: string,
  beforeEgress?: () => Promise<void>,
): Promise<void> {
  const { redis, cloudBaseUrl, getAuthHeader } = deps;
  const authHeader = getAuthHeader();

  const identity = await resolveIdentity(
    redis,
    cloudBaseUrl,
    authHeader,
    adapter.platform,
    event.senderId,
    event.senderName,
  );

  if (!identity) {
    logger.info("Identity not linked; routing message to onboarding chat", {
      project,
      platform: adapter.platform,
      senderId: event.senderId,
    });
    await sendOnboardingReply(adapter, config, event, deps, beforeEgress);
    return;
  }

  const agentId = explicitAgentId || identity.agentId || config.agentId;

  const server = await resolveAgentServer(redis, agentId);
  if (!server) {
    logger.error("No server found for agent", { project, agentId });
    throw new Error(`No server found for agent ${agentId}`);
  }

  adapter.sendTypingIndicator(config, event).catch((err) => {
    logger.debug("sendTypingIndicator failed", {
      platform: adapter.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  refreshKedaActivity(redis, server.serverName).catch((err) => {
    logger.warn("refreshKedaActivity failed", {
      serverName: server.serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let responseText: string;
  try {
    responseText = await forwardToServer(
      server.serverUrl,
      server.serverName,
      agentId,
      identity.userId,
      event.text,
      {
        platformName: adapter.platform,
        senderName: event.senderName,
        chatId: event.chatId,
      },
    );
  } catch (err) {
    logger.error("Forward to server failed", {
      error: err instanceof Error ? err.message : String(err),
      project,
      platform: adapter.platform,
      agentId,
    });
    throw err;
  }

  // An empty responseText is a deliberate no-response from the agent (mute /
  // shouldRespond=no), not content: forwarding it would make platform adapters
  // (WhatsApp/Twilio/Telegram) attempt an invalid empty send. Skip the reply so
  // "agent chose silence" sends nothing, staying distinct from a forward
  // failure (which returned above) and from a real reply.
  // error-policy:J5 no-op — deliberate agent silence, nothing to deliver.
  if (responseText.length === 0) {
    logger.debug("Agent produced no reply; skipping send", {
      agentId,
      platform: adapter.platform,
    });
    return;
  }

  try {
    await beforeEgress?.();
    await adapter.sendReply(config, event, responseText);
  } catch (err) {
    logger.error("Failed to send reply", {
      error: err instanceof Error ? err.message : String(err),
      platform: adapter.platform,
    });
    throw err;
  }
}

async function sendOnboardingReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  beforeEgress?: () => Promise<void>,
): Promise<void> {
  const { cloudBaseUrl, getAuthHeader } = deps;

  const response = await fetch(
    `${cloudBaseUrl}/api/eliza-app/onboarding/chat`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeader(),
      },
      body: JSON.stringify({
        sessionId: `platform:${adapter.platform}:${event.senderId}`,
        message: event.text,
        platform: adapter.platform,
        platformUserId: event.senderId,
        platformDisplayName: event.senderName,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `onboarding chat failed (${response.status}) ${body.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as {
    data?: {
      reply?: string;
    };
  };
  const reply =
    body.data?.reply ??
    "I can get your Eliza Cloud agent set up. Open https://app.elizacloud.ai/get-started to continue.";
  await beforeEgress?.();
  await adapter.sendReply(config, event, reply);
}

function ackResponse(platform: Platform): Response {
  // Twilio expects empty TwiML
  if (platform === "twilio") {
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      },
    );
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
