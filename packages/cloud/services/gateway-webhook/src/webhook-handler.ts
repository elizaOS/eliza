/** Handles authenticated connector webhooks from verification through reply delivery. */
import {
  executeResponseAttempts,
  type ResponseAttemptsResult,
} from "@elizaos/cloud-services-common/response-attempts";
import {
  executeTelegramDelivery,
  type TelegramDeliveryHooks,
  type TelegramDeliveryLedger,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "@elizaos/cloud-services-common/telegram-delivery";
import type {
  ChatEvent,
  Platform,
  PlatformAdapter,
  WebhookConfig,
} from "./adapters/types";
import { reacquireAuthHeader } from "./auth";
import { resolveConnectorAccountId } from "./connector-account";
import { tryConfirmIdentityLink } from "./identity-link";
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
const PERSONAL_SHARED_ATTEMPTS = 3;
const PERSONAL_SHARED_RETRY_DELAY_CAP_MS = 5_000;
const PROCESSING_TTL_SECONDS = 120;
const TELEGRAM_DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const TELEGRAM_EGRESS_STARTED = "egress_started";
const TELEGRAM_DELIVERED = "delivered";
const TELEGRAM_TYPING_REFRESH_MS = 4_000;
const PERSONAL_SHARED_VOICE_TIMEOUT_MS = 90_000;
// Inbound Blooio image turns may spend the cloud stage fetching media and
// running a vision description before the model turn; the plain 30s ceiling
// would abort those turns mid-flight and re-run them.
const PERSONAL_SHARED_MEDIA_TIMEOUT_MS = 90_000;
const ELIZA_TRACE_ID_HEADER = "X-Eliza-Trace-Id";
const OPAQUE_TRACE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ZERO_TRACE_ID = "0".repeat(32);

class PersonalSharedPreEgressError extends Error {
  override readonly name = "PersonalSharedPreEgressError";
}

interface HandlerDeps {
  redis: GatewayRedis;
  cloudBaseUrl: string;
  deliveryAuthoritySecret?: string;
  getAuthHeader: () => { Authorization: string };
  reacquireAuthHeader?: () => Promise<Record<string, string>>;
}

interface PersonalSharedDeliveryTiming {
  cloudMs: number;
  cloudAttempts: number;
  egressMs: number;
  cloudServerTiming: string | null;
}

interface MessageTraceContext {
  traceId: string;
  gatewayReceivedAtMs: number;
}

async function reconcileLegacyTelegramDelivery(
  deps: HandlerDeps,
  project: string,
  event: ChatEvent,
  traceId: string,
  operation: "mark_uncertain" | "mark_delivered",
): Promise<"uncertain" | "delivered"> {
  const secret = (deps.deliveryAuthoritySecret ?? "").trim();
  if (!secret) {
    throw new Error("Telegram delivery authority secret is not configured");
  }
  const response = await fetch(
    `${deps.cloudBaseUrl}/api/eliza-app/webhook/telegram/delivery`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ELIZA_TRACE_ID_HEADER]: traceId,
        "X-Eliza-Webhook-Forwarder-Secret": secret,
      },
      body: JSON.stringify({
        project,
        senderId: event.senderId,
        messageId: event.messageId,
        operation,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Telegram delivery reconciliation failed (${response.status})`,
    );
  }
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("state" in body) ||
    (body.state !== "uncertain" && body.state !== "delivered")
  ) {
    throw new Error("Telegram delivery reconciliation returned invalid JSON");
  }
  return body.state;
}

async function forwardPersonalTelegramToEdge(
  request: Request,
  rawBody: string,
  deps: HandlerDeps,
  project: string,
  event: ChatEvent,
  dedupKey: string,
  traceId: string,
): Promise<Response> {
  const secret = (deps.deliveryAuthoritySecret ?? "").trim();
  if (!secret) {
    throw new Error("Telegram delivery authority secret is not configured");
  }
  const legacy = await deps.redis.get<string>(dedupKey);
  if (legacy === TELEGRAM_EGRESS_STARTED || legacy === TELEGRAM_DELIVERED) {
    const reconciled = await reconcileLegacyTelegramDelivery(
      deps,
      project,
      event,
      traceId,
      legacy === TELEGRAM_DELIVERED ? "mark_delivered" : "mark_uncertain",
    );
    if (reconciled === "delivered") {
      await deps.redis.set(dedupKey, TELEGRAM_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
      return ackResponse("telegram");
    }
    return new Response(
      JSON.stringify({ error: "delivery outcome uncertain" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const processingKey = `${dedupKey}:processing`;
  const processingClaimed = await deps.redis.set(processingKey, "1", {
    nx: true,
    ex: PROCESSING_TTL_SECONDS,
  });
  if (!processingClaimed) {
    return new Response(JSON.stringify({ error: "update in progress" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const marker = await deps.redis.get<string>(dedupKey);
    if (!marker) {
      await deps.redis.set(dedupKey, TELEGRAM_EGRESS_STARTED, {
        nx: true,
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
    } else if (marker !== TELEGRAM_EGRESS_STARTED) {
      throw new Error("Telegram delivery authority transition conflicted");
    }
    const telegramSignature =
      request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    const response = await fetch(
      `${deps.cloudBaseUrl}/api/eliza-app/webhook/telegram/edge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ELIZA_TRACE_ID_HEADER]: traceId,
          "X-Eliza-Webhook-Forwarder-Secret": secret,
          "X-Telegram-Bot-Api-Secret-Token": telegramSignature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(PERSONAL_SHARED_VOICE_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      await deps.redis.set(dedupKey, TELEGRAM_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
    }
    return response;
  } finally {
    await deps.redis.del(processingKey);
  }
}

function redisTelegramDeliveryLedger(
  redis: GatewayRedis,
  dedupKey: string,
): TelegramDeliveryLedger {
  const processingKey = `${dedupKey}:processing`;
  const planKey = `${dedupKey}:plan`;
  const chunkKey = (chunkIndex: number, chunkDigest: string) =>
    `${dedupKey}:chunk:${chunkIndex}:${chunkDigest}`;
  const decodeChunk = (
    encoded: string | null,
  ): { state: TelegramDeliveryState; providerMessageId?: string } | null => {
    if (encoded === "uncertain" || encoded === "delivered") {
      return { state: encoded };
    }
    if (!encoded) return null;
    try {
      const parsed = JSON.parse(encoded) as {
        state?: unknown;
        providerMessageId?: unknown;
      };
      if (
        parsed.state === "delivered" &&
        typeof parsed.providerMessageId === "string"
      ) {
        return {
          state: "delivered",
          providerMessageId: parsed.providerMessageId,
        };
      }
    } catch {
      // error-policy:J3 Redis delivery state is untrusted persisted input; an
      // invalid value is treated as absent, never as permission to resend.
    }
    return null;
  };
  return {
    async read() {
      const state = await redis.get<string>(dedupKey);
      if (state === TELEGRAM_EGRESS_STARTED || state === "uncertain") {
        return "uncertain";
      }
      return state === TELEGRAM_DELIVERED ? "delivered" : null;
    },
    async claimProcessing() {
      return Boolean(
        await redis.set(processingKey, "1", {
          nx: true,
          ex: PROCESSING_TTL_SECONDS,
        }),
      );
    },
    async releaseProcessing() {
      await redis.del(processingKey);
    },
    async preparePlan(chunkDigests) {
      const encoded = JSON.stringify(chunkDigests);
      const existing = await redis.get<string>(planKey);
      if (existing !== null) {
        return existing === encoded ? "prepared" : "conflict";
      }
      const claimed = await redis.set(planKey, encoded, {
        nx: true,
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
      if (claimed) return "prepared";
      return (await redis.get<string>(planKey)) === encoded
        ? "prepared"
        : "conflict";
    },
    async readChunk(chunkIndex, chunkDigest) {
      return (
        decodeChunk(await redis.get<string>(chunkKey(chunkIndex, chunkDigest)))
          ?.state ?? null
      );
    },
    async readChunkProviderMessageId(chunkIndex, chunkDigest) {
      return (
        decodeChunk(await redis.get<string>(chunkKey(chunkIndex, chunkDigest)))
          ?.providerMessageId ?? null
      );
    },
    async claimChunk(chunkIndex, chunkDigest) {
      return Boolean(
        await redis.set(chunkKey(chunkIndex, chunkDigest), "uncertain", {
          nx: true,
          ex: TELEGRAM_DELIVERY_TTL_SECONDS,
        }),
      );
    },
    async releaseChunk(chunkIndex, chunkDigest) {
      await redis.del(chunkKey(chunkIndex, chunkDigest));
    },
    async markChunkDelivered(chunkIndex, chunkDigest, providerMessageId) {
      await redis.set(
        chunkKey(chunkIndex, chunkDigest),
        JSON.stringify({ state: "delivered", providerMessageId }),
        { ex: TELEGRAM_DELIVERY_TTL_SECONDS },
      );
    },
    async markDelivered() {
      await redis.set(dedupKey, TELEGRAM_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
    },
  };
}

function resolveTraceId(request: Request): string {
  const supplied = request.headers.get(ELIZA_TRACE_ID_HEADER)?.trim();
  if (
    supplied &&
    OPAQUE_TRACE_ID.test(supplied) &&
    supplied.toLowerCase() !== ZERO_TRACE_ID
  ) {
    return supplied.toLowerCase();
  }
  return crypto.randomUUID();
}

export async function handleWebhook(
  request: Request,
  adapter: PlatformAdapter,
  deps: HandlerDeps,
  project: string,
  agentId?: string,
): Promise<Response> {
  const trace: MessageTraceContext = {
    traceId: resolveTraceId(request),
    gatewayReceivedAtMs: Date.now(),
  };
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

  const event = await adapter.extractEvent(rawBody, config);
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
  if (adapter.platform === "telegram") {
    try {
      const configuredPersonalProject =
        (process.env.ELIZA_APP_WEBHOOK_PROJECT ?? "eliza-app").trim() ||
        "eliza-app";
      if (
        !agentId &&
        project === configuredPersonalProject &&
        event.chatType !== "group" &&
        event.chatType !== "supergroup" &&
        deps.deliveryAuthoritySecret !== undefined
      ) {
        return forwardPersonalTelegramToEdge(
          request,
          rawBody,
          deps,
          project,
          event,
          dedupKey,
          trace.traceId,
        );
      }
      const localLedger = redisTelegramDeliveryLedger(redis, dedupKey);
      const outcome = await executeTelegramDelivery(
        localLedger,
        (deliveryHooks) =>
          processMessage(
            adapter,
            config,
            event,
            deps,
            project,
            trace,
            agentId,
            deliveryHooks,
          ),
      );
      if (outcome === "uncertain") {
        logger.error(
          "Telegram webhook delivery outcome is uncertain; refusing replay",
          { platform: adapter.platform, messageId: event.messageId, dedupKey },
        );
        return new Response(
          JSON.stringify({ error: "delivery outcome uncertain" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      if (outcome === "in_progress") {
        return new Response(JSON.stringify({ error: "update in progress" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (outcome === "duplicate") {
        logger.debug("Duplicate webhook skipped", {
          platform: adapter.platform,
          messageId: event.messageId,
          dedupKey,
        });
      }
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
    }
  }

  const priorDeliveryState = await redis.get<string>(dedupKey);
  if (priorDeliveryState) {
    logger.debug("Duplicate webhook skipped", {
      platform: adapter.platform,
      messageId: event.messageId,
      dedupKey,
    });
    return ackResponse(adapter.platform);
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

  processMessage(adapter, config, event, deps, project, trace, agentId).catch(
    async (err) => {
      logger.error("Background message processing failed", {
        error: err instanceof Error ? err.message : String(err),
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        traceId: trace.traceId,
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
  trace: MessageTraceContext,
  explicitAgentId?: string,
  deliveryHooks?: TelegramDeliveryHooks,
): Promise<void> {
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  const { redis, cloudBaseUrl, getAuthHeader } = deps;
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
  const authHeader = getAuthHeader();

  // Link challenges are proof-bearing control messages, including when the
  // handle currently resolves to a provisional onboarding account. Inspect
  // them before every personal or agent route so no existing row can swallow
  // the challenge as ordinary agent text.
  const linkAttempt = await tryConfirmIdentityLink(
    { redis, cloudBaseUrl, getAuthHeader },
    adapter.platform,
    event.senderId,
    event.senderName,
    event.text,
  );
  if (linkAttempt.handled && linkAttempt.reply) {
    await adapter.sendReply(config, event, linkAttempt.reply, deliveryHooks);
    return;
  }

  // The public eliza.app phone/Telegram endpoints are account transports, not
  // arbitrary agent webhooks. Always converge them through the same internal
  // personal route, including after Dedicated cutover. Direct agent-server
  // forwarding used `userId` as its room and forked connector turns away from
  // the imported `personal:*` conversation.
  if (!explicitAgentId && isPersonalElizaTransport(adapter.platform)) {
    // Membership transitions mutate routing state only. Emitting a typing
    // action while the bot is being removed is both misleading and violates
    // the no-provider-egress membership contract.
    const stopTyping = event.membershipChange
      ? () => undefined
      : beginTypingFeedback(adapter, config, event);
    try {
      const timing = await sendPersonalSharedReply(
        adapter,
        config,
        event,
        deps,
        project,
        trace.traceId,
        deliveryHooks,
      );
      logger.info("Personal Eliza connector message completed", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        traceId: trace.traceId,
        providerToGatewayMs:
          event.providerSentAtMs === undefined
            ? null
            : trace.gatewayReceivedAtMs - event.providerSentAtMs,
        cloudMs: timing.cloudMs,
        cloudAttempts: timing.cloudAttempts,
        cloudServerTiming: timing.cloudServerTiming,
        egressMs: timing.egressMs,
        totalMs: Date.now() - startedAt,
      });
    } finally {
      stopTyping();
    }
    return;
  }

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
      trace.traceId,
      deliveryHooks,
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
  // agent is still a resolved agent, and re-onboarding one would misroute an
  // established identity. Provisioning belongs to explicit lifecycle
  // surfaces; onboarding provisioning status is observation-only.
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
      trace.traceId,
      deliveryHooks,
    );
    return;
  }

  const stopTyping = beginTypingFeedback(adapter, config, event);
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
    await adapter.sendReply(config, event, responseText, deliveryHooks);
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

function isPersonalElizaTransport(
  platform: Platform,
): platform is "telegram" | "twilio" | "blooio" {
  return (
    platform === "telegram" || platform === "twilio" || platform === "blooio"
  );
}

function groupInvocationForEvent(
  event: ChatEvent,
): "mention" | "command" | "reply" | "ambient" {
  if (event.groupInvocation) return event.groupInvocation;
  if (event.replyToMessageId) return "reply";
  if (/^\s*(?:\/|eliza\b)/i.test(event.text)) return "command";
  if (/(?:^|\s)@eliza\b/i.test(event.text)) return "mention";
  return "ambient";
}

function beginTypingFeedback(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
): () => void {
  if (adapter.platform === "telegram") {
    return startTypingRefreshLoop(adapter, config, event);
  }
  adapter.sendTypingIndicator(config, event).catch((err) => {
    logger.debug("sendTypingIndicator failed", {
      platform: adapter.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return () => {
    adapter.stopTypingIndicator?.(config, event).catch((err) => {
      logger.debug("stopTypingIndicator failed", {
        platform: adapter.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}

async function sendUnlinkedReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  traceId: string,
  deliveryHooks?: TelegramDeliveryHooks,
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
      traceId,
      deliveryHooks,
    );
    return;
  }
  await sendOnboardingReply(adapter, config, event, deps, deliveryHooks);
}

async function sendPersonalSharedReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  traceId: string,
  deliveryHooks?: TelegramDeliveryHooks,
): Promise<PersonalSharedDeliveryTiming> {
  const { cloudBaseUrl, getAuthHeader } = deps;
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
  const connectorAccountId = resolveConnectorAccountId(
    adapter.platform,
    config,
  );
  if (!connectorAccountId) {
    throw new PersonalSharedPreEgressError(
      "connector account identity is not configured",
    );
  }
  const isGroup = event.chatType === "group" || event.chatType === "supergroup";
  const sendReplyWithReceipt = adapter.sendReplyWithReceipt;
  if (isGroup && !sendReplyWithReceipt) {
    throw new PersonalSharedPreEgressError(
      "group connector cannot return a provider delivery receipt",
    );
  }
  const voiceNote = event.voiceNote
    ? await adapter.resolveVoiceNote?.(config, event)
    : undefined;
  if (event.voiceNote && !voiceNote) {
    throw new PersonalSharedPreEgressError(
      "connector cannot resolve the supplied voice note",
    );
  }
  // Media turns mirror voice: the cloud route may spend fetch + vision + the
  // model turn, so a re-POST can overlap a still-running route execution and
  // re-run the unbilled vision call. Group Blooio events carry mediaUrls too
  // but are never forwarded as media (no vision runs), so they keep the plain
  // text-turn retry/timeout posture.
  const isMediaTurn =
    adapter.platform === "blooio" && !isGroup && !!event.mediaUrls?.length;
  // Voice and media turns can spend most of the 120-second processing lease in
  // STT/vision + the model. Only a stale-auth retry is safe inline; provider/
  // transport failures reopen the webhook for the platform's durable retry
  // instead of overlapping it.
  const isLongTurn = Boolean(voiceNote) || isMediaTurn;
  const maxAttempts = isLongTurn ? 2 : PERSONAL_SHARED_ATTEMPTS;
  const postMessage = (authHeader: Record<string, string>) =>
    fetch(`${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ELIZA_TRACE_ID_HEADER]: traceId,
        ...authHeader,
      },
      body: JSON.stringify(
        event.membershipChange
          ? {
              eventType: "membership",
              platform: "telegram",
              project,
              connectorAccountId,
              chatId: event.chatId,
              messageId: `telegram:${project}:${event.messageId}`,
              membershipChange: event.membershipChange,
            }
          : isGroup &&
              (adapter.platform === "telegram" || adapter.platform === "blooio")
            ? {
                platform: adapter.platform,
                chatType: event.chatType,
                project,
                connectorAccountId,
                chatId: event.chatId,
                actor: {
                  platformUserId: event.senderId,
                  ...(event.senderName
                    ? { displayName: event.senderName }
                    : {}),
                  role:
                    adapter.platform === "telegram"
                      ? (event.groupActorRole ?? "unknown")
                      : "possessor",
                },
                messageId: `${adapter.platform}:${project}:${event.messageId}`,
                message: event.text,
                invocation: groupInvocationForEvent(event),
                ...(event.replyToMessageId
                  ? { replyToMessageId: event.replyToMessageId }
                  : {}),
              }
            : adapter.platform === "telegram"
              ? {
                  platform: "telegram",
                  project,
                  connectorAccountId,
                  chatId: event.chatId,
                  telegramUserId: event.senderId,
                  displayName: event.senderName,
                  messageId: `telegram:${project}:${event.messageId}`,
                  ...(event.text ? { message: event.text } : {}),
                  ...(voiceNote ? { voiceNote } : {}),
                }
              : {
                  platform: adapter.platform,
                  project,
                  connectorAccountId,
                  phoneNumber: event.senderId,
                  messageId: `${adapter.platform}:${project}:${event.messageId}`,
                  message: event.text,
                  // Only Blooio media URLs are provider-hosted and fetchable
                  // by the cloud vision path; other platforms keep text-only.
                  ...(isMediaTurn && event.mediaUrls?.length
                    ? { mediaUrls: event.mediaUrls }
                    : {}),
                },
      ),
      signal: AbortSignal.timeout(
        voiceNote
          ? PERSONAL_SHARED_VOICE_TIMEOUT_MS
          : isMediaTurn
            ? PERSONAL_SHARED_MEDIA_TIMEOUT_MS
            : 30_000,
      ),
    });

  let authHeader: Record<string, string> = getAuthHeader();
  let attemptResult: ResponseAttemptsResult;
  try {
    attemptResult = await executeResponseAttempts({
      maxAttempts,
      authRefreshAttemptsOutsideBudget: 1,
      request: () => postMessage(authHeader),
      refreshAuth: async () => {
        authHeader = await reauth();
      },
      retryStatuses: !isLongTurn,
      retryTransport: !isLongTurn,
      retryDelayCapMs: PERSONAL_SHARED_RETRY_DELAY_CAP_MS,
      observe: (observation) => {
        const response = observation.response;
        const attemptContext = {
          traceId,
          project,
          platform: adapter.platform,
          messageId: event.messageId,
          attempt: observation.attempt,
          maxAttempts: observation.maxAttempts,
          durationMs: observation.durationMs,
          status: response?.status ?? null,
          retryable: observation.retryable,
          retryReason: observation.retryReason,
          retryAfterSeconds: observation.retryAfterSeconds,
          retryDelayMs: observation.retryDelayMs,
          cloudServerTiming: response?.headers.get("Server-Timing") ?? null,
          cloudFailureStage:
            response?.headers.get("X-Eliza-Failure-Stage") ?? null,
          cloudFailureName:
            response?.headers.get("X-Eliza-Failure-Name") ?? null,
          ...(observation.error
            ? {
                error:
                  observation.error instanceof Error
                    ? observation.error.message
                    : String(observation.error),
              }
            : {}),
        };
        if (observation.retryReason === "auth_refresh") {
          logger.warn(
            "Personal Shared Cloud attempt requires fresh auth",
            attemptContext,
          );
        } else if (response?.ok) {
          logger.info(
            "Personal Shared Cloud attempt completed",
            attemptContext,
          );
        } else if (response) {
          logger.warn("Personal Shared Cloud attempt failed", attemptContext);
        } else {
          logger.warn(
            "Personal Shared Cloud attempt transport failed",
            attemptContext,
          );
        }
      },
    });
  } catch (error) {
    throw new PersonalSharedPreEgressError(
      `personal Shared chat transport failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { response } = attemptResult;
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
  const cloudServerTiming = response.headers.get("Server-Timing");
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // error-policy:J3 a successful transport response is still untrusted until
    // its JSON contract parses; provider egress has not started at this point.
    throw new PersonalSharedPreEgressError(
      "personal Shared chat returned invalid JSON",
      { cause: error },
    );
  }
  const cloudMs = attemptResult.durationMs;
  const reply =
    body && typeof body === "object" && "data" in body
      ? (body.data as { reply?: unknown } | null)?.reply
      : undefined;
  if (typeof reply !== "string") {
    throw new PersonalSharedPreEgressError(
      "personal Shared chat returned no reply",
    );
  }
  // Empty is the agent's deliberate shouldRespond=no result. It is a
  // successful turn with no provider egress, not a malformed response.
  if (reply.length === 0) {
    return {
      cloudMs,
      cloudAttempts: attemptResult.attempts,
      egressMs: 0,
      cloudServerTiming,
    };
  }
  const egressStartedAt = Date.now();
  if (isGroup) {
    if (!sendReplyWithReceipt) {
      throw new PersonalSharedPreEgressError(
        "group connector cannot return a provider delivery receipt",
      );
    }
    const receipt = await sendReplyWithReceipt(
      config,
      event,
      reply,
      deliveryHooks,
    );
    const receiptBody = JSON.stringify({
      eventType: "delivery_receipt",
      platform: adapter.platform,
      project,
      connectorAccountId,
      chatId: event.chatId,
      sourceMessageId: `${adapter.platform}:${project}:${event.messageId}`,
      providerMessageIds: receipt.providerMessageIds,
    });
    const postReceipt = (header: Record<string, string>) =>
      fetch(`${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ELIZA_TRACE_ID_HEADER]: traceId,
          ...header,
        },
        body: receiptBody,
        signal: AbortSignal.timeout(10_000),
      });
    let receiptResponse = await postReceipt(authHeader);
    if (receiptResponse.status === 401 || receiptResponse.status === 403) {
      await receiptResponse.body?.cancel();
      authHeader = await reauth();
      receiptResponse = await postReceipt(authHeader);
    }
    if (!receiptResponse.ok) {
      await receiptResponse.body?.cancel();
      throw new Error(
        `group delivery receipt persistence failed (${receiptResponse.status})`,
      );
    }
    await receiptResponse.body?.cancel();
  } else {
    await adapter.sendReply(config, event, reply, deliveryHooks);
  }
  return {
    cloudMs,
    cloudAttempts: attemptResult.attempts,
    egressMs: Date.now() - egressStartedAt,
    cloudServerTiming,
  };
}

async function sendOnboardingReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  deliveryHooks?: TelegramDeliveryHooks,
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
  await adapter.sendReply(config, event, reply, deliveryHooks);
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
