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
// Must outlive the 75s non-idempotent message-forward budget plus Telegram
// egress. Otherwise a provider retry can reclaim the update while the first
// worker is still generating and execute the same user turn twice.
const PROCESSING_TTL_SECONDS = 120;
const PERSONAL_SHARED_ATTEMPTS = 3;
const TELEGRAM_DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const TELEGRAM_EGRESS_STARTED = "egress_started";
const TELEGRAM_DELIVERED = "delivered";
const TELEGRAM_TYPING_REFRESH_MS = 4_000;

class TelegramEgressAlreadyClaimedError extends Error {
  override readonly name = "TelegramEgressAlreadyClaimedError";
}

class PersonalSharedPreEgressError extends Error {
  override readonly name = "PersonalSharedPreEgressError";
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
    async (err) => {
      logger.error("Background message processing failed", {
        error: err instanceof Error ? err.message : String(err),
        project,
        platform: adapter.platform,
        messageId: event.messageId,
      });
      if (err instanceof PersonalSharedPreEgressError) {
        try {
          // The Shared endpoint is idempotent and provider egress has not
          // started, so reopening lets the messaging provider retry safely.
          await redis.del(dedupKey);
        } catch (cleanupError) {
          // error-policy:J7 The original delivery failure is already observed;
          // cleanup diagnostics must not create another unhandled rejection.
          logger.error("Failed to reopen personal Shared webhook delivery", {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
            project,
            platform: adapter.platform,
            messageId: event.messageId,
          });
        }
      }
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
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
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
  const identityMs = Date.now() - stageStartedAt;
  stageStartedAt = Date.now();

  if (!identity) {
    logger.info(
      "Identity not linked; routing message to the account entry service",
      {
        project,
        platform: adapter.platform,
        senderId: event.senderId,
      },
    );
    await sendUnlinkedReply(
      adapter,
      config,
      event,
      deps,
      project,
      beforeEgress,
    );
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
  const routingMs = Date.now() - stageStartedAt;

  if (!agentId || server.kind !== "ready") {
    if (explicitAgentId || server.kind === "unreachable") {
      logger.error("No server found for agent", {
        project,
        agentId,
        reason: server.kind,
      });
      return;
    }
    logger.info(
      "Sender has no running agent; routing message to the account entry service",
      {
        project,
        platform: adapter.platform,
        senderId: event.senderId,
        agentId,
      },
    );
    await sendUnlinkedReply(
      adapter,
      config,
      event,
      deps,
      project,
      beforeEgress,
    );
    return;
  }

  const stopTyping =
    adapter.platform === "telegram"
      ? startTypingRefreshLoop(adapter, config, event)
      : () => undefined;
  if (adapter.platform !== "telegram") {
    adapter.sendTypingIndicator(config, event).catch((err) => {
      logger.debug("sendTypingIndicator failed", {
        platform: adapter.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  refreshKedaActivity(redis, server.serverName).catch((err) => {
    logger.warn("refreshKedaActivity failed", {
      serverName: server.serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let responseText: string;
  stageStartedAt = Date.now();
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
  } finally {
    stopTyping();
  }
  const forwardMs = Date.now() - stageStartedAt;

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
    stageStartedAt = Date.now();
    await beforeEgress?.();
    await adapter.sendReply(config, event, responseText);
    logger.info("Connector message completed", {
      project,
      platform: adapter.platform,
      agentId,
      messageId: event.messageId,
      identityMs,
      routingMs,
      forwardMs,
      egressMs: Date.now() - stageStartedAt,
      totalMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error("Failed to send reply", {
      error: err instanceof Error ? err.message : String(err),
      platform: adapter.platform,
    });
    throw err;
  }
}

/**
 * Telegram expires a `typing` action after roughly five seconds. Refresh it
 * while the agent turn is in flight so a slow but healthy response never looks
 * like a dead bot. The loop is presentation-only and never enters the egress
 * dedupe boundary.
 */
export function startTypingRefreshLoop(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  intervalMs = TELEGRAM_TYPING_REFRESH_MS,
): () => void {
  let stopped = false;
  let sending = false;

  const send = async (): Promise<void> => {
    if (stopped || sending) return;
    sending = true;
    try {
      await adapter.sendTypingIndicator(config, event);
    } catch (err) {
      logger.debug("sendTypingIndicator failed", {
        platform: adapter.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sending = false;
    }
  };

  void send();
  const timer = setInterval(() => void send(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function sendUnlinkedReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  beforeEgress?: () => Promise<void>,
): Promise<void> {
  if (
    adapter.platform === "telegram" ||
    adapter.platform === "twilio" ||
    adapter.platform === "blooio"
  ) {
    await sendPersonalSharedReply(
      adapter,
      config,
      event,
      deps,
      project,
      beforeEgress,
    );
    return;
  }
  await sendOnboardingReply(adapter, config, event, deps, beforeEgress);
}

async function sendPersonalSharedReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  beforeEgress?: () => Promise<void>,
): Promise<void> {
  const { cloudBaseUrl, getAuthHeader } = deps;
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
  const postMessage = (authHeader: Record<string, string>) =>
    fetch(`${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify(
        adapter.platform === "telegram"
          ? {
              platform: "telegram",
              telegramUserId: event.senderId,
              displayName: event.senderName,
              messageId: `telegram:${project}:${event.messageId}`,
              message: event.text,
            }
          : {
              platform: adapter.platform,
              phoneNumber: event.senderId,
              messageId: `${adapter.platform}:${project}:${event.messageId}`,
              message: event.text,
            },
      ),
      signal: AbortSignal.timeout(30_000),
    });

  let authHeader: Record<string, string> = getAuthHeader();
  let response: Response | null = null;
  let lastTransportError: unknown;
  for (let attempt = 1; attempt <= PERSONAL_SHARED_ATTEMPTS; attempt += 1) {
    try {
      response = await postMessage(authHeader);
      if (response.status === 401 && attempt < PERSONAL_SHARED_ATTEMPTS) {
        authHeader = await reauth();
        continue;
      }
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      if (response.ok || !retryable || attempt === PERSONAL_SHARED_ATTEMPTS) {
        break;
      }
    } catch (error) {
      response = null;
      lastTransportError = error;
      if (attempt === PERSONAL_SHARED_ATTEMPTS) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
  }
  if (!response) {
    throw new PersonalSharedPreEgressError(
      `personal Shared chat transport failed: ${lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError)}`,
      { cause: lastTransportError },
    );
  }
  if (!response.ok) {
    let diagnostics: string;
    try {
      diagnostics = (await response.text()).slice(0, 200);
    } catch (error) {
      // error-policy:J1 preserve a failed optional diagnostic body read.
      diagnostics = `unable to read response body: ${error instanceof Error ? error.message : String(error)}`;
    }
    throw new PersonalSharedPreEgressError(
      `personal Shared chat failed (${response.status}) ${diagnostics}`,
    );
  }
  const body: unknown = await response.json();
  const reply =
    body && typeof body === "object" && "data" in body
      ? (body.data as { reply?: unknown } | null)?.reply
      : undefined;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new PersonalSharedPreEgressError(
      "personal Shared chat returned no reply",
    );
  }
  await beforeEgress?.();
  await adapter.sendReply(config, event, reply);
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
