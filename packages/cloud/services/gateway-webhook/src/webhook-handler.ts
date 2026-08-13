/** Handles authenticated connector webhooks from verification through reply delivery. */
import type {
  ChatEvent,
  Platform,
  PlatformAdapter,
  WebhookConfig,
} from "./adapters/types";
import { reacquireAuthHeader } from "./auth";
import { resolveConnectorAccountId } from "./connector-account";
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

class TelegramEgressAlreadyClaimedError extends Error {
  override readonly name = "TelegramEgressAlreadyClaimedError";
}

interface HandlerDeps {
  redis: GatewayRedis;
  cloudBaseUrl: string;
  getAuthHeader: () => { Authorization: string };
  reacquireAuthHeader?: () => Promise<Record<string, string>>;
}

export async function handleWebhook(
  request: Request,
  adapter: PlatformAdapter,
  deps: HandlerDeps,
  project: string,
  agentId?: string,
): Promise<Response> {
  const { redis, cloudBaseUrl, getAuthHeader } = deps;
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
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
    reauth,
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

    let egressStarted = false;
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
          const egressClaimed = await redis.set(
            dedupKey,
            TELEGRAM_EGRESS_STARTED,
            {
              nx: true,
              ex: TELEGRAM_DELIVERY_TTL_SECONDS,
            },
          );
          if (!egressClaimed) {
            throw new TelegramEgressAlreadyClaimedError(
              "Telegram egress was already claimed for this update",
            );
          }
          egressStarted = true;
        },
      );
      await redis.set(dedupKey, TELEGRAM_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
      return ackResponse(adapter.platform);
    } catch (error) {
      if (error instanceof TelegramEgressAlreadyClaimedError) {
        // error-policy:J1 A competing worker owns the delivery boundary; return
        // an explicit retryable response without attempting a second send.
        return new Response(
          JSON.stringify({ error: "egress already claimed" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw error;
    } finally {
      if (!egressStarted) {
        await redis.del(processingKey);
      }
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
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
  const authHeader = getAuthHeader();

  const identity = await resolveIdentity(
    redis,
    cloudBaseUrl,
    authHeader,
    adapter.platform,
    event.senderId,
    event.senderName,
    reauth,
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

  // A per-agent webhook URL names the agent to serve, so among senders who
  // reach this point it keeps precedence over whatever they happen to own —
  // diverting a sender with a cloud account but no sandbox onto personal
  // onboarding would run that flow on somebody else's bot. (A sender with no
  // account at all is already onboarded by the branch above, per-agent URL or
  // not; that predates this routing and is unchanged here.)
  //
  // On the shared webhook the decision is "is there an agent that can actually
  // serve this message", which needs both the sandbox row AND its registry key:
  // the row appears the moment provisioning starts, the key only once a
  // container has booted. Branching on the row alone would answer the first
  // message and then go silent again for every message until boot — for good,
  // if provisioning ends in error. Never branch on `sandbox.status`: a stopped
  // agent is still a resolved agent, and re-onboarding one would provision a
  // duplicate (the single guard against that is the early return on an
  // existing sandbox in ensureElizaAppProvisioning).
  //
  // `unreachable` is deliberately NOT onboarding: that is an established agent
  // whose pod stopped heartbeating, and the onboarding state machine would tell
  // its owner "you're live" while the message goes nowhere, then copy the
  // transcript into the agent's memory a second time.
  const agentId = explicitAgentId ?? identity.agentId;
  const server = agentId
    ? await resolveAgentServer(redis, agentId)
    : ({ kind: "unregistered" } as const);

  if (!agentId || server.kind !== "ready") {
    if (explicitAgentId || server.kind === "unreachable") {
      logger.error("No server found for agent", {
        project,
        agentId,
        reason: server.kind,
      });
      return;
    }
    logger.info("Sender has no running agent; routing message to onboarding", {
      project,
      platform: adapter.platform,
      senderId: event.senderId,
      agentId,
    });
    await sendOnboardingReply(adapter, config, event, deps);
    return;
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
        accountId: resolveConnectorAccountId(adapter.platform, config),
        platformRecordId: event.platformRecordId ?? event.messageId,
        chatType: event.chatType,
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
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;

  const postOnboarding = (authHeader: Record<string, string>) =>
    fetch(`${cloudBaseUrl}/api/eliza-app/onboarding/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The onboarding route and its session coordinator both keep a replay
        // ledger on this header. Without it the only protection against a
        // platform redelivering a message is the 5-minute dedup key, and a
        // later retry would append the message to the transcript twice and
        // re-enter provisioning.
        "Idempotency-Key": event.messageId,
        ...authHeader,
      },
      body: JSON.stringify({
        sessionId: `platform:${adapter.platform}:${event.senderId}`,
        message: event.text,
        platform: adapter.platform,
        platformUserId: event.senderId,
        platformDisplayName: event.senderName,
        platformReplyAddress:
          adapter.platform === "blooio"
            ? config.fromNumber
            : adapter.platform === "twilio"
              ? config.phoneNumber
              : undefined,
      }),
      signal: AbortSignal.timeout(30_000),
    });

  let response = await postOnboarding(getAuthHeader());
  // A Worker redeploy strands the cached token until its scheduled refresh;
  // the Idempotency-Key above makes this replay safe. One retry, then the
  // normal error path.
  if (response.status === 401) {
    response = await postOnboarding(await reauth());
  }

  if (!response.ok) {
    let diagnostics: string;
    try {
      diagnostics = (await response.text()).slice(0, 200);
    } catch (error) {
      // error-policy:J1 The HTTP status is authoritative at this delivery
      // boundary; preserve a failed optional body read in its diagnostic.
      diagnostics = `unable to read response body: ${error instanceof Error ? error.message : String(error)}`;
    }
    throw new Error(
      `onboarding chat failed (${response.status}) ${diagnostics}`,
    );
  }

  const body: unknown = await response.json();
  const reply =
    body && typeof body === "object" && "data" in body
      ? (body.data as { reply?: unknown } | null)?.reply
      : undefined;
  if (typeof reply !== "string" || reply.trim().length === 0) {
    throw new Error("onboarding chat returned no reply");
  }
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
