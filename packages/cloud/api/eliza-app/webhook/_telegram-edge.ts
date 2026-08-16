/**
 * Executes the official Personal Shared Telegram connector entirely inside the
 * Cloudflare Worker. The shared connector package owns provider protocol and
 * exact-once state semantics; the canonical internal route still owns account,
 * Dedicated cutover, memory, model, and response behavior.
 */

import {
  extractIdentityLinkCode,
  identityLinkReply,
} from "@elizaos/cloud-services-common/identity-link-code";
import { executeResponseAttempts } from "@elizaos/cloud-services-common/response-attempts";
import {
  parseTelegramWebhook,
  resolveTelegramVoiceNote,
  sendTelegramReply,
  sendTelegramTyping,
  type TelegramConnectorConfig,
  type TelegramConnectorEvent,
  verifyTelegramWebhook,
} from "@elizaos/cloud-services-common/telegram-connector";
import {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "@elizaos/cloud-services-common/telegram-delivery";
import type { Hono, ExecutionContext as HonoExecutionContext } from "hono";
import { PERSONAL_TELEGRAM_DELIVERY_PATH } from "@/api-app/personal-telegram-delivery";
import { appendServerTiming } from "@/lib/observability/http-telemetry";
import { sha256Hex } from "@/lib/oidc/crypto";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const MAX_ATTEMPTS = 3;
const VOICE_MAX_ATTEMPTS = 2;
const RETRY_DELAY_CAP_MS = 5_000;
const TYPING_REFRESH_MS = 4_000;

export interface TelegramEdgeDeps {
  runTurn(
    body: Record<string, unknown>,
    traceId: string,
    env: AppEnv["Bindings"],
    executionCtx: HonoExecutionContext,
  ): Promise<Response>;
  confirmIdentityLink?(
    body: Record<string, unknown>,
    traceId: string,
    env: AppEnv["Bindings"],
    executionCtx: HonoExecutionContext,
  ): Promise<Response>;
}

interface LedgerResponse {
  state?: TelegramDeliveryState | null;
  claimed?: boolean;
}

function readEnvString(env: AppEnv["Bindings"], key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function defaultRunTurn(
  body: Record<string, unknown>,
  traceId: string,
  env: AppEnv["Bindings"],
  executionCtx: HonoExecutionContext,
): Promise<Response> {
  const [{ default: app }] = await Promise.all([
    import("../../internal/eliza-app/personal-shared/messages/route"),
  ]);
  const localSecret = crypto.randomUUID();
  const localEnv = { ...env, INTERNAL_SECRET: localSecret };
  return (app as Hono<AppEnv>).request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localSecret}`,
        "Content-Type": "application/json",
        "X-Eliza-Trace-Id": traceId,
      },
      body: JSON.stringify(body),
    },
    localEnv,
    executionCtx,
  );
}

async function defaultConfirmIdentityLink(
  body: Record<string, unknown>,
  traceId: string,
  env: AppEnv["Bindings"],
  executionCtx: HonoExecutionContext,
): Promise<Response> {
  const { default: app } = await import("../identity-link/confirm/route");
  const localSecret = crypto.randomUUID();
  return (app as Hono<AppEnv>).request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localSecret}`,
        "Content-Type": "application/json",
        "X-Eliza-Trace-Id": traceId,
      },
      body: JSON.stringify(body),
    },
    { ...env, INTERNAL_SECRET: localSecret },
    executionCtx,
  );
}

async function callLedger(
  stub: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  },
  messageId: string,
  operation: string,
): Promise<LedgerResponse> {
  const response = await stub.fetch(
    `https://personal-telegram-delivery${PERSONAL_TELEGRAM_DELIVERY_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, operation }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Telegram delivery ledger failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") {
    throw new Error("Telegram delivery ledger returned invalid JSON");
  }
  return body as LedgerResponse;
}

async function edgeLedger(
  env: AppEnv["Bindings"],
  project: string,
  botToken: string,
  event: TelegramConnectorEvent,
): Promise<TelegramDeliveryLedger> {
  const namespace = env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace)
    throw new Error("Personal Telegram delivery binding is missing");
  const accountFingerprint = await sha256Hex(botToken);
  const stub = namespace.getByName(
    `telegram:${project}:${accountFingerprint}:${event.senderId}`,
  );
  return {
    async read() {
      const body = await callLedger(stub, event.messageId, "read");
      return body.state === "egress_started" || body.state === "delivered"
        ? body.state
        : null;
    },
    async claimProcessing() {
      return (
        (await callLedger(stub, event.messageId, "claim_processing"))
          .claimed === true
      );
    },
    async releaseProcessing() {
      await callLedger(stub, event.messageId, "release_processing");
    },
    async claimEgress() {
      return (
        (await callLedger(stub, event.messageId, "claim_egress")).claimed ===
        true
      );
    },
    async markDelivered() {
      await callLedger(stub, event.messageId, "mark_delivered");
    },
  };
}

function startTyping(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
): () => void {
  let stopped = false;
  let sending = false;
  const send = async (): Promise<void> => {
    if (stopped || sending) return;
    sending = true;
    try {
      await sendTelegramTyping(config, event);
    } catch (error) {
      logger.debug("[PersonalTelegramEdge] typing indicator failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      sending = false;
    }
  };
  void send();
  const timer = setInterval(() => void send(), TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function deliveryBody(
  project: string,
  event: TelegramConnectorEvent,
  voiceNote?: Awaited<ReturnType<typeof resolveTelegramVoiceNote>>,
): Record<string, unknown> {
  return {
    platform: "telegram",
    project,
    chatId: event.chatId,
    telegramUserId: event.senderId,
    displayName: event.senderName,
    messageId: `telegram:${project}:${event.messageId}`,
    ...(event.text ? { message: event.text } : {}),
    ...(voiceNote ? { voiceNote } : {}),
  };
}

async function runTurnWithRetry(
  c: AppContext,
  deps: TelegramEdgeDeps,
  body: Record<string, unknown>,
  event: TelegramConnectorEvent,
  traceId: string,
): Promise<{ response: Response; attempts: number; turnMs: number }> {
  const maxAttempts = event.voiceNote ? VOICE_MAX_ATTEMPTS : MAX_ATTEMPTS;
  const result = await executeResponseAttempts({
    maxAttempts,
    request: () => deps.runTurn(body, traceId, c.env, c.executionCtx),
    retryStatuses: !event.voiceNote,
    retryTransport: !event.voiceNote,
    retryDelayCapMs: RETRY_DELAY_CAP_MS,
    observe: (observation) => {
      const response = observation.response;
      const context = {
        traceId,
        platform: "telegram",
        messageId: event.messageId,
        attempt: observation.attempt,
        maxAttempts: observation.maxAttempts,
        durationMs: observation.durationMs,
        status: response?.status ?? null,
        retryable: observation.retryable,
        retryReason: observation.retryReason,
        retryAfterSeconds: observation.retryAfterSeconds,
        retryDelayMs: observation.retryDelayMs,
        workerServerTiming: response?.headers.get("Server-Timing") ?? null,
        failureStage: response?.headers.get("X-Eliza-Failure-Stage") ?? null,
        failureName: response?.headers.get("X-Eliza-Failure-Name") ?? null,
        ...(observation.error
          ? {
              error:
                observation.error instanceof Error
                  ? observation.error.message
                  : String(observation.error),
            }
          : {}),
      };
      if (response?.ok) {
        logger.info("[PersonalTelegramEdge] turn attempt completed", context);
      } else {
        logger.warn("[PersonalTelegramEdge] turn attempt failed", context);
      }
    },
  });
  return {
    response: result.response,
    attempts: result.attempts,
    turnMs: result.durationMs,
  };
}

export async function handlePersonalTelegramEdge(
  c: AppContext,
  deps: TelegramEdgeDeps = {
    runTurn: defaultRunTurn,
    confirmIdentityLink: defaultConfirmIdentityLink,
  },
): Promise<Response> {
  const startedAt = performance.now();
  const traceId = c.get("traceId");
  const webhookSecret = readEnvString(
    c.env,
    "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
  );
  const botToken = readEnvString(c.env, "ELIZA_APP_TELEGRAM_BOT_TOKEN");
  if (!webhookSecret || !botToken) {
    logger.error("[PersonalTelegramEdge] connector secret is not configured");
    return c.json(
      { success: false, error: "Telegram connector is not configured" },
      503,
    );
  }
  if (!verifyTelegramWebhook(c.req.raw, webhookSecret)) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const rawBody = await c.req.text();
  const event = parseTelegramWebhook(rawBody, logger);
  if (!event) return c.json({ ok: true });
  const providerToWorkerMs =
    event.providerSentAtMs === undefined
      ? null
      : Date.now() - event.providerSentAtMs;
  const project =
    readEnvString(c.env, "ELIZA_APP_WEBHOOK_PROJECT") ?? "eliza-app";
  const config = { botToken, webhookSecret };
  const ledger = await edgeLedger(c.env, project, botToken, event);

  try {
    let turnMs = 0;
    let egressMs = 0;
    let attempts = 0;
    const outcome = await executeTelegramDelivery(
      ledger,
      async (beforeEgress) => {
        const stopTyping = startTyping(config, event);
        try {
          const linkCode = extractIdentityLinkCode(event.text);
          if (linkCode) {
            const confirmationStartedAt = performance.now();
            const confirmation = await (
              deps.confirmIdentityLink ?? defaultConfirmIdentityLink
            )(
              {
                code: linkCode,
                platform: "telegram",
                platformId: event.senderId,
                platformName: event.senderName,
              },
              traceId,
              c.env,
              c.executionCtx,
            );
            turnMs = Math.round(performance.now() - confirmationStartedAt);
            attempts = 1;
            let status = "linked";
            if (!confirmation.ok) {
              if (confirmation.status !== 409) {
                await confirmation.body?.cancel();
                throw new Error(
                  `Identity-link confirmation failed (${confirmation.status})`,
                );
              }
              const payload: unknown = await confirmation.json();
              status =
                payload && typeof payload === "object" && "data" in payload
                  ? String(
                      (payload.data as { status?: unknown } | null)?.status ??
                        "unknown",
                    )
                  : "unknown";
            } else {
              await confirmation.body?.cancel();
            }
            await beforeEgress();
            const egressStartedAt = performance.now();
            await sendTelegramReply(
              config,
              event,
              identityLinkReply(status),
              logger,
            );
            egressMs = Math.round(performance.now() - egressStartedAt);
            return;
          }
          const voiceNote = event.voiceNote
            ? await resolveTelegramVoiceNote(config, event)
            : undefined;
          const turn = await runTurnWithRetry(
            c,
            deps,
            deliveryBody(project, event, voiceNote),
            event,
            traceId,
          );
          turnMs = turn.turnMs;
          attempts = turn.attempts;
          if (!turn.response.ok) {
            const status = turn.response.status;
            await turn.response.body?.cancel();
            throw new Error(`Personal Shared edge turn failed (${status})`);
          }
          const payload: unknown = await turn.response.json();
          const reply =
            payload && typeof payload === "object" && "data" in payload
              ? (payload.data as { reply?: unknown } | null)?.reply
              : undefined;
          if (typeof reply !== "string") {
            throw new Error("Personal Shared edge turn returned no reply");
          }
          if (!reply) return;
          await beforeEgress();
          const egressStartedAt = performance.now();
          await sendTelegramReply(config, event, reply, logger);
          egressMs = Math.round(performance.now() - egressStartedAt);
        } finally {
          stopTyping();
        }
      },
    );

    if (outcome === "uncertain") {
      return c.json(
        { success: false, error: "Delivery outcome uncertain" },
        503,
      );
    }
    if (outcome === "in_progress") {
      return c.json({ success: false, error: "Update in progress" }, 503);
    }
    const totalMs = Math.round(performance.now() - startedAt);
    logger.info("[PersonalTelegramEdge] connector message completed", {
      traceId,
      project,
      messageId: event.messageId,
      outcome,
      providerToWorkerMs,
      turnMs,
      attempts,
      egressMs,
      totalMs,
    });
    const response = c.json({ ok: true });
    appendServerTiming(response.headers, [
      { name: "personal_edge_turn", durationMs: turnMs },
      { name: "telegram_egress", durationMs: egressMs },
    ]);
    return response;
  } catch (error) {
    if (error instanceof TelegramEgressAlreadyClaimedError) {
      return c.json({ success: false, error: "Egress already claimed" }, 503);
    }
    throw error;
  }
}
