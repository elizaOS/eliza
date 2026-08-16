/** Handles authenticated connector webhooks from verification through reply delivery. */
import {
  executeResponseAttempts,
  type ResponseAttemptsResult,
} from "@elizaos/cloud-services-common/response-attempts";
import {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryProgress,
} from "@elizaos/cloud-services-common/telegram-delivery";
import type {
  ChatEvent,
  Platform,
  PlatformAdapter,
  WebhookConfig,
} from "./adapters/types";
import { reacquireAuthHeader } from "./auth";
import {
  resolveConnectorAccountId,
  resolveTelegramBotAccountFingerprint,
} from "./connector-account";
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
const TELEGRAM_DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const TELEGRAM_TYPING_REFRESH_MS = 4_000;
const PERSONAL_SHARED_VOICE_TIMEOUT_MS = 90_000;
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
  getAuthHeader: () => { Authorization: string };
  reacquireAuthHeader?: () => Promise<Record<string, string>>;
  /** Test seam; production always resolves the canonical Cloud ledger. */
  personalTelegramLedger?: TelegramDeliveryLedger;
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

type ReplyDelivery = (text: string) => Promise<void>;

export function redisTelegramDeliveryLedger(
  redis: GatewayRedis,
  dedupKey: string,
): TelegramDeliveryLedger {
  const processingKey = `${dedupKey}:processing`;
  const evalRedis = async (
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> => {
    if (!redis.eval) throw new Error("Redis atomic scripting is unavailable");
    return redis.eval(script, keys, args);
  };
  const readProgress = async (): Promise<TelegramDeliveryProgress | null> => {
    const value = await redis.get<TelegramDeliveryProgress | string>(dedupKey);
    if (value === "delivered") {
      return {
        state: "delivered",
        contentDigest: "",
        totalChunks: 0,
        nextChunkIndex: 0,
        providerMessageIds: [],
      };
    }
    if (value === "egress_started") {
      return {
        state: "egress_started",
        contentDigest: "",
        totalChunks: 1,
        nextChunkIndex: 0,
        activeChunkIndex: 0,
        providerMessageIds: [],
      };
    }
    return value && typeof value === "object" ? value : null;
  };
  const writeOwned = async (
    ownerToken: string,
    progress: TelegramDeliveryProgress,
  ): Promise<void> => {
    const result = await evalRedis(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]); return 1 else return 0 end",
      [processingKey, dedupKey],
      [
        ownerToken,
        JSON.stringify(progress),
        String(TELEGRAM_DELIVERY_TTL_SECONDS),
      ],
    );
    if (Number(result) !== 1)
      throw new Error("Telegram processing claim was lost");
  };
  return {
    read: readProgress,
    async claimProcessing(ownerToken, leaseMs): Promise<boolean> {
      return Boolean(
        await redis.set(processingKey, ownerToken, {
          nx: true,
          ex: Math.ceil(leaseMs / 1_000),
        }),
      );
    },
    async renewProcessing(ownerToken, leaseMs): Promise<boolean> {
      return (
        Number(
          await evalRedis(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
            [processingKey],
            [ownerToken, String(Math.ceil(leaseMs / 1_000))],
          ),
        ) === 1
      );
    },
    async releaseProcessing(ownerToken): Promise<void> {
      await evalRedis(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        [processingKey],
        [ownerToken],
      );
    },
    async preparePlan(ownerToken, plan) {
      const existing = await readProgress();
      const progress = existing ?? {
        state: "pending" as const,
        ...plan,
        nextChunkIndex: 0,
        providerMessageIds: [],
      };
      if (
        progress.contentDigest !== plan.contentDigest ||
        progress.totalChunks !== plan.totalChunks
      )
        throw new Error("Telegram delivery plan conflicts with persisted plan");
      if (!existing) await writeOwned(ownerToken, progress);
      return progress;
    },
    async claimChunk(ownerToken, chunkIndex) {
      const progress = await readProgress();
      if (
        progress?.state !== "pending" ||
        progress.nextChunkIndex !== chunkIndex ||
        chunkIndex >= progress.totalChunks
      )
        return false;
      await writeOwned(ownerToken, {
        ...progress,
        state: "egress_started",
        activeChunkIndex: chunkIndex,
      });
      return true;
    },
    async recordAccepted(ownerToken, chunkIndex, providerMessageId) {
      const progress = await readProgress();
      if (
        progress?.state !== "egress_started" ||
        progress.activeChunkIndex !== chunkIndex
      )
        throw new Error("Invalid Telegram acceptance transition");
      const next = {
        ...progress,
        state: "pending" as const,
        nextChunkIndex: chunkIndex + 1,
        providerMessageIds: [...progress.providerMessageIds, providerMessageId],
      };
      delete next.activeChunkIndex;
      await writeOwned(ownerToken, next);
    },
    async recordExplicitRejection(ownerToken, chunkIndex) {
      const progress = await readProgress();
      if (
        progress?.state !== "egress_started" ||
        progress.activeChunkIndex !== chunkIndex
      )
        throw new Error("Invalid Telegram rejection transition");
      const next = { ...progress, state: "pending" as const };
      delete next.activeChunkIndex;
      await writeOwned(ownerToken, next);
    },
    async markDelivered(ownerToken): Promise<void> {
      const progress = await readProgress();
      if (
        progress?.state !== "pending" ||
        progress.nextChunkIndex !== progress.totalChunks
      )
        throw new Error("Telegram delivery is incomplete");
      await writeOwned(ownerToken, { ...progress, state: "delivered" });
    },
  };
}

const PERSONAL_TELEGRAM_LEDGER_PATH =
  "/api/internal/eliza-app/personal-shared/telegram-delivery";

function canonicalTelegramDeliveryLedger(
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  traceId: string,
): TelegramDeliveryLedger {
  if (!config.botToken) {
    throw new Error("Official Personal Shared Telegram bot token is missing");
  }
  const accountFingerprint = resolveTelegramBotAccountFingerprint(
    config.botToken,
  );
  const call = async (
    operation: string,
    input: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const request = async (authHeader: Record<string, string>) =>
      fetch(`${deps.cloudBaseUrl}${PERSONAL_TELEGRAM_LEDGER_PATH}`, {
        method: "POST",
        headers: {
          ...authHeader,
          "Content-Type": "application/json",
          "X-Eliza-Trace-Id": traceId,
        },
        body: JSON.stringify({
          project,
          accountFingerprint,
          senderId: event.senderId,
          messageId: event.messageId,
          operation,
          ...input,
        }),
      });
    let response = await request(deps.getAuthHeader());
    if (response.status === 401) {
      await response.body?.cancel();
      response = await request(
        await (deps.reacquireAuthHeader ?? reacquireAuthHeader)(),
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Canonical Telegram delivery ledger failed (${response.status})`,
      );
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") {
      throw new Error(
        "Canonical Telegram delivery ledger returned invalid JSON",
      );
    }
    return body as Record<string, unknown>;
  };
  return {
    async read() {
      const body = await call("read");
      return (body.progress as TelegramDeliveryProgress | null) ?? null;
    },
    async claimProcessing(ownerToken, leaseMs) {
      const claimed = (await call("claim_processing", { ownerToken, leaseMs }))
        .claimed;
      if (typeof claimed !== "boolean") {
        throw new Error(
          "Canonical Telegram delivery ledger returned invalid claim",
        );
      }
      return claimed;
    },
    async renewProcessing(ownerToken, leaseMs) {
      const renewed = (await call("renew_processing", { ownerToken, leaseMs }))
        .renewed;
      if (typeof renewed !== "boolean") {
        throw new Error(
          "Canonical Telegram delivery ledger returned invalid renewal",
        );
      }
      return renewed;
    },
    async releaseProcessing(ownerToken) {
      await call("release_processing", { ownerToken });
    },
    async preparePlan(ownerToken, plan) {
      const progress = (await call("prepare_plan", { ownerToken, ...plan }))
        .progress;
      if (!progress || typeof progress !== "object") {
        throw new Error(
          "Canonical Telegram delivery ledger returned invalid progress",
        );
      }
      return progress as TelegramDeliveryProgress;
    },
    async claimChunk(ownerToken, chunkIndex) {
      const claimed = (await call("claim_chunk", { ownerToken, chunkIndex }))
        .claimed;
      if (typeof claimed !== "boolean") {
        throw new Error(
          "Canonical Telegram delivery ledger returned invalid claim",
        );
      }
      return claimed;
    },
    async recordAccepted(ownerToken, chunkIndex, providerMessageId) {
      await call("record_accepted", {
        ownerToken,
        chunkIndex,
        providerMessageId,
      });
    },
    async recordExplicitRejection(ownerToken, chunkIndex) {
      await call("record_explicit_rejection", { ownerToken, chunkIndex });
    },
    async markDelivered(ownerToken) {
      await call("mark_delivered", { ownerToken });
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
  if (adapter.platform === "telegram") {
    const ledger =
      deps.personalTelegramLedger ??
      (!agentId && project === "eliza-app"
        ? canonicalTelegramDeliveryLedger(
            config,
            event,
            deps,
            project,
            trace.traceId,
          )
        : redisTelegramDeliveryLedger(redis, dedupKey));
    const outcome = await executeTelegramDelivery(ledger, (dispatch) => {
      if (!adapter.prepareReply || !adapter.sendReplyChunk) {
        throw new Error("Telegram adapter lacks durable chunk delivery");
      }
      const prepareReply = adapter.prepareReply;
      const sendReplyChunk = adapter.sendReplyChunk;
      return processMessage(
        adapter,
        config,
        event,
        deps,
        project,
        trace,
        agentId,
        async (text) =>
          dispatch(await prepareReply(text), (chunk) =>
            sendReplyChunk(config, event, chunk),
          ),
      );
    });
    if (outcome.status === "uncertain") {
      logger.error(
        "Telegram webhook delivery outcome is uncertain; acknowledging without replay",
        { platform: adapter.platform, messageId: event.messageId, dedupKey },
      );
      return ackResponse(adapter.platform);
    }
    if (outcome.status === "in_progress") {
      return new Response(JSON.stringify({ error: "update in progress" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (outcome.status === "explicitly_rejected") {
      if (outcome.errorCode !== 429 && outcome.errorCode < 500) {
        logger.warn("Telegram provider permanently rejected delivery", {
          platform: adapter.platform,
          messageId: event.messageId,
          chunkIndex: outcome.chunkIndex,
          errorCode: outcome.errorCode,
        });
        return ackResponse(adapter.platform);
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (outcome.retryAfterSeconds)
        headers["Retry-After"] = String(outcome.retryAfterSeconds);
      return new Response(
        JSON.stringify({ error: "provider rejected delivery" }),
        { status: 503, headers },
      );
    }
    if (outcome.status === "duplicate") {
      logger.debug("Duplicate webhook skipped", {
        platform: adapter.platform,
        messageId: event.messageId,
        dedupKey,
      });
    }
    return ackResponse(adapter.platform);
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
  deliverReply?: ReplyDelivery,
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
    await (deliverReply
      ? deliverReply(linkAttempt.reply)
      : adapter.sendReply(config, event, linkAttempt.reply));
    return;
  }

  // The public eliza.app phone/Telegram endpoints are account transports, not
  // arbitrary agent webhooks. Always converge them through the same internal
  // personal route, including after Dedicated cutover. Direct agent-server
  // forwarding used `userId` as its room and forked connector turns away from
  // the imported `personal:*` conversation.
  if (!explicitAgentId && isPersonalElizaTransport(adapter.platform)) {
    const stopTyping = beginTypingFeedback(adapter, config, event);
    try {
      const timing = await sendPersonalSharedReply(
        adapter,
        config,
        event,
        deps,
        project,
        trace.traceId,
        deliverReply,
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
      deliverReply,
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
      trace.traceId,
      deliverReply,
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
    await (deliverReply
      ? deliverReply(responseText)
      : adapter.sendReply(config, event, responseText));
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
  return () => undefined;
}

async function sendUnlinkedReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  traceId: string,
  deliverReply?: ReplyDelivery,
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
      deliverReply,
    );
    return;
  }
  await sendOnboardingReply(adapter, config, event, deps, deliverReply);
}

async function sendPersonalSharedReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  traceId: string,
  deliverReply?: ReplyDelivery,
): Promise<PersonalSharedDeliveryTiming> {
  const { cloudBaseUrl, getAuthHeader } = deps;
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
  const voiceNote = event.voiceNote
    ? await adapter.resolveVoiceNote?.(config, event)
    : undefined;
  if (event.voiceNote && !voiceNote) {
    throw new PersonalSharedPreEgressError(
      "connector cannot resolve the supplied voice note",
    );
  }
  // Voice turns can spend most of the 120-second processing lease in STT + the
  // model. Only a stale-auth retry is safe inline; provider/transport failures
  // reopen the webhook for Telegram's durable retry instead of overlapping it.
  const maxAttempts = voiceNote ? 2 : PERSONAL_SHARED_ATTEMPTS;
  const postMessage = (authHeader: Record<string, string>) =>
    fetch(`${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ELIZA_TRACE_ID_HEADER]: traceId,
        ...authHeader,
      },
      body: JSON.stringify(
        adapter.platform === "telegram"
          ? {
              platform: "telegram",
              project,
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
              phoneNumber: event.senderId,
              messageId: `${adapter.platform}:${project}:${event.messageId}`,
              message: event.text,
            },
      ),
      signal: AbortSignal.timeout(
        voiceNote ? PERSONAL_SHARED_VOICE_TIMEOUT_MS : 30_000,
      ),
    });

  let authHeader: Record<string, string> = getAuthHeader();
  let attemptResult: ResponseAttemptsResult;
  try {
    attemptResult = await executeResponseAttempts({
      maxAttempts,
      request: () => postMessage(authHeader),
      refreshAuth: async () => {
        authHeader = await reauth();
      },
      retryStatuses: !voiceNote,
      retryTransport: !voiceNote,
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
  const body: unknown = await response.json();
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
  await (deliverReply
    ? deliverReply(reply)
    : adapter.sendReply(config, event, reply));
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
  deliverReply?: ReplyDelivery,
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
  await (deliverReply
    ? deliverReply(reply)
    : adapter.sendReply(config, event, reply));
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
