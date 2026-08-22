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
  TelegramApiResponseError,
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
import { runWithDbCacheAsync } from "@/db/client";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { appendServerTiming } from "@/lib/observability/http-telemetry";
import { sha256Hex } from "@/lib/oidc/crypto";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { runWithRequestContext } from "@/lib/runtime/request-context";
import { setRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const MAX_ATTEMPTS = 3;
const VOICE_MAX_ATTEMPTS = 2;
const RETRY_DELAY_CAP_MS = 5_000;
const TYPING_REFRESH_MS = 4_000;
const DELIVERY_PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DELIVERY_SENDER_RE = /^\d{1,32}$/;

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
  plan?: "prepared" | "conflict";
  acceptedAt?: unknown;
  providerMessageIds?: unknown;
}

export interface PersonalTelegramReminderDispatchInput {
  project: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

export type PersonalTelegramReminderDispatchResult =
  | {
      ok: true;
      acceptedAt: string;
      providerMessageIds: string[];
    }
  | {
      ok: false;
      acceptance: "not_accepted" | "unknown";
      message: string;
      retryAfterMinutes?: number;
    };

function readEnvString(env: AppEnv["Bindings"], key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function runInternalRoute(
  app: Hono<AppEnv>,
  body: Record<string, unknown>,
  traceId: string,
  idempotencyKey: string,
  env: AppEnv["Bindings"],
  executionCtx: HonoExecutionContext,
): Promise<Response> {
  const localSecret = crypto.randomUUID();
  const localEnv = { ...env, INTERNAL_SECRET: localSecret };
  setRuntimeR2Bucket(env.BLOB);
  return runWithCloudBindingsAsync(localEnv as Record<string, unknown>, () =>
    runWithRequestContext(
      {
        idempotencyKey,
        defer: (task) => executionCtx.waitUntil(task),
      },
      () =>
        runWithDbCacheAsync(() =>
          Promise.resolve(
            app.request(
              "/",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${localSecret}`,
                  "Content-Type": "application/json",
                  "Idempotency-Key": idempotencyKey,
                  "X-Eliza-Trace-Id": traceId,
                },
                body: JSON.stringify(body),
              },
              localEnv,
              executionCtx,
            ),
          ),
        ),
    ),
  );
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
  const messageId = body.messageId;
  return runInternalRoute(
    app as Hono<AppEnv>,
    body,
    traceId,
    typeof messageId === "string" && messageId
      ? messageId
      : `telegram-turn:${traceId}`,
    env,
    executionCtx,
  );
}

export async function defaultConfirmIdentityLink(
  body: Record<string, unknown>,
  traceId: string,
  env: AppEnv["Bindings"],
  executionCtx: HonoExecutionContext,
): Promise<Response> {
  const { default: app } = await import("../identity-link/confirm/route");
  const platform = String(body.platform ?? "telegram");
  const platformId = String(body.platformId ?? "unknown");
  const code = String(body.code ?? "unknown");
  const confirmationId = await sha256Hex(
    `identity-link:${platform}:${platformId}:${code}`,
  );
  return runInternalRoute(
    app as Hono<AppEnv>,
    body,
    traceId,
    `identity-link:${confirmationId}`,
    env,
    executionCtx,
  );
}

async function callLedger(
  stub: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  },
  messageId: string,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<LedgerResponse> {
  const response = await stub.fetch(
    `https://personal-telegram-delivery${PERSONAL_TELEGRAM_DELIVERY_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, operation, ...input }),
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

export function verifyPersonalTelegramGatewayRequest(c: AppContext): boolean {
  const configuredSecret = readEnvString(
    c.env,
    "ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
  );
  const presentedSecret =
    c.req.header("X-Eliza-Webhook-Forwarder-Secret")?.trim() ?? "";
  return Boolean(
    configuredSecret &&
      timingSafeEqualSecret(presentedSecret, configuredSecret),
  );
}

export async function handlePersonalTelegramDeliveryLedger(
  c: AppContext,
): Promise<Response> {
  if (!verifyPersonalTelegramGatewayRequest(c)) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // error-policy:J3 the authenticated gateway payload is still untrusted JSON.
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ success: false, error: "Invalid request" }, 400);
  }
  const input = body as Record<string, unknown>;
  const project = input.project;
  const senderId = input.senderId;
  if (
    typeof project !== "string" ||
    !DELIVERY_PROJECT_RE.test(project) ||
    typeof senderId !== "string" ||
    !DELIVERY_SENDER_RE.test(senderId)
  ) {
    return c.json({ success: false, error: "Invalid delivery scope" }, 400);
  }
  const namespace = c.env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace) {
    return c.json({ success: false, error: "Delivery binding missing" }, 503);
  }
  const stub = namespace.getByName(
    `telegram:${project}:personal-shared:${senderId}`,
  );
  const response = await stub.fetch(
    `https://personal-telegram-delivery${PERSONAL_TELEGRAM_DELIVERY_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        project: undefined,
        senderId: undefined,
      }),
    },
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function edgeLedger(
  env: AppEnv["Bindings"],
  project: string,
  event: TelegramConnectorEvent,
): Promise<TelegramDeliveryLedger> {
  const namespace = env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace)
    throw new Error("Personal Telegram delivery binding is missing");
  const stub = namespace.getByName(
    `telegram:${project}:personal-shared:${event.senderId}`,
  );
  return {
    async read() {
      const body = await callLedger(stub, event.messageId, "read");
      return body.state === "uncertain" || body.state === "delivered"
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
    async preparePlan(chunkDigests) {
      const body = await callLedger(stub, event.messageId, "prepare_plan", {
        chunkDigests,
      });
      return body.plan === "prepared" ? "prepared" : "conflict";
    },
    async readChunk(chunkIndex, chunkDigest) {
      const body = await callLedger(stub, event.messageId, "read_chunk", {
        chunkIndex,
        chunkDigest,
      });
      return body.state === "uncertain" || body.state === "delivered"
        ? body.state
        : null;
    },
    // The edge flow records complete delivery receipts separately. Personal
    // Shared groups use the gateway Redis ledger, where this per-chunk value
    // repairs a failed receipt POST without resending provider messages.
    async readChunkProviderMessageId() {
      return null;
    },
    async claimChunk(chunkIndex, chunkDigest) {
      return (
        (
          await callLedger(stub, event.messageId, "claim_chunk", {
            chunkIndex,
            chunkDigest,
          })
        ).claimed === true
      );
    },
    async releaseChunk(chunkIndex, chunkDigest) {
      await callLedger(stub, event.messageId, "release_chunk", {
        chunkIndex,
        chunkDigest,
      });
    },
    async markChunkDelivered(chunkIndex, chunkDigest, providerMessageId) {
      await callLedger(stub, event.messageId, "mark_chunk_delivered", {
        chunkIndex,
        chunkDigest,
        providerMessageId,
      });
    },
    async markDelivered() {
      await callLedger(stub, event.messageId, "mark_delivered");
    },
  };
}

async function readEdgeReceipt(
  env: AppEnv["Bindings"],
  project: string,
  event: TelegramConnectorEvent,
): Promise<{ acceptedAt: string; providerMessageIds: string[] } | null> {
  const namespace = env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace) return null;
  const stub = namespace.getByName(
    `telegram:${project}:personal-shared:${event.senderId}`,
  );
  const body = await callLedger(stub, event.messageId, "read_receipt");
  const acceptedAt =
    typeof body.acceptedAt === "string" &&
    Number.isFinite(Date.parse(body.acceptedAt))
      ? body.acceptedAt
      : null;
  const providerMessageIds = Array.isArray(body.providerMessageIds)
    ? body.providerMessageIds.filter(
        (value): value is string =>
          typeof value === "string" && /^\d{1,32}$/.test(value),
      )
    : [];
  return acceptedAt && providerMessageIds.length > 0
    ? { acceptedAt, providerMessageIds }
    : null;
}

/**
 * Delivers a scheduled Personal Shared Telegram reminder with the same bot and
 * exact-once Durable Object ledger as conversational edge replies.
 */
export async function dispatchPersonalTelegramReminder(
  env: AppEnv["Bindings"],
  input: PersonalTelegramReminderDispatchInput,
): Promise<PersonalTelegramReminderDispatchResult> {
  const botToken = readEnvString(env, "ELIZA_APP_TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    return {
      ok: false,
      acceptance: "not_accepted",
      message: "Telegram connector is not configured",
    };
  }
  const event: TelegramConnectorEvent = {
    platform: "telegram",
    messageId: input.idempotencyKey,
    platformRecordId: input.idempotencyKey,
    chatId: input.chatId,
    chatType: "private",
    senderId: input.chatId,
    text: "",
    isCommand: false,
    rawPayload: { source: "shared-reminder" },
  };
  try {
    const ledger = await edgeLedger(env, input.project, event);
    const outcome = await executeTelegramDelivery(ledger, async (hooks) => {
      await sendTelegramReply({ botToken }, event, input.text, logger, hooks);
    });
    if (outcome === "uncertain" || outcome === "in_progress") {
      return {
        ok: false,
        acceptance: "unknown",
        message: `Telegram reminder delivery is ${outcome}`,
      };
    }
    const receipt = await readEdgeReceipt(env, input.project, event);
    return receipt
      ? { ok: true, ...receipt }
      : {
          ok: false,
          acceptance: "unknown",
          message: "Telegram returned no durable provider receipt",
        };
  } catch (error) {
    if (error instanceof TelegramApiResponseError) {
      return {
        ok: false,
        acceptance: "not_accepted",
        message: error.message,
        ...(error.errorCode === 429 && error.retryAfterSeconds
          ? {
              retryAfterMinutes: Math.max(
                1,
                Math.ceil(error.retryAfterSeconds / 60),
              ),
            }
          : {}),
      };
    }
    return {
      ok: false,
      acceptance: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
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
      // error-policy:J4 typing is a non-critical user-facing enhancement.
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
  const ledger = await edgeLedger(c.env, project, event);

  try {
    let turnMs = 0;
    let egressMs = 0;
    let attempts = 0;
    const outcome = await executeTelegramDelivery(
      ledger,
      async (deliveryHooks) => {
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
            const egressStartedAt = performance.now();
            await sendTelegramReply(
              config,
              event,
              identityLinkReply(status),
              logger,
              deliveryHooks,
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
          const egressStartedAt = performance.now();
          await sendTelegramReply(config, event, reply, logger, deliveryHooks);
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
    // error-policy:J1 translate an exact delivery-claim conflict at the route boundary.
    if (error instanceof TelegramEgressAlreadyClaimedError) {
      return c.json({ success: false, error: "Egress already claimed" }, 503);
    }
    throw error;
  }
}
