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
import {
  PERSONAL_SHARED_FAILURE_REPLY,
  readPersonalSharedFailureMetadata,
} from "@elizaos/cloud-services-common/personal-shared-failure";
import { executeResponseAttempts } from "@elizaos/cloud-services-common/response-attempts";
import {
  attestTelegramBotIdentity,
  parseTelegramWebhook,
  resolveTelegramVoiceNote,
  sendTelegramReply,
  sendTelegramTyping,
  TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER,
  TelegramApiResponseError,
  type TelegramConnectorConfig,
  type TelegramConnectorEvent,
  TelegramIdentityAttestationError,
  verifyTelegramWebhook,
} from "@elizaos/cloud-services-common/telegram-connector";
import {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "@elizaos/cloud-services-common/telegram-delivery";
import type { Hono, ExecutionContext as HonoExecutionContext } from "hono";
import {
  isPersonalTelegramDeliveryEpoch1CompatEnabled,
  PERSONAL_TELEGRAM_DELIVERY_EPOCH,
  PERSONAL_TELEGRAM_DELIVERY_PATH,
} from "@/api-app/personal-telegram-delivery";
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
const DELIVERY_THREAD_RE = /^[1-9]\d{0,15}$/;
const DELIVERY_MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const TELEGRAM_CONNECTOR_ACCOUNT_RE = /^bot:(?:\d{1,20}|[0-9a-f]{64})$/;
const SAFE_OBSERVED_ERROR_NAMES = new Set([
  "AbortError",
  "Error",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
]);

function safeObservedErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return SAFE_OBSERVED_ERROR_NAMES.has(name) ? name : "OtherError";
}

class PersonalTelegramPreEgressError extends Error {
  override readonly name = "PersonalTelegramPreEgressError";
  readonly failure: ReturnType<typeof readPersonalSharedFailureMetadata> | null;
  readonly attempts: number | null;
  readonly turnMs: number | null;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      failure?: ReturnType<typeof readPersonalSharedFailureMetadata> | null;
      attempts?: number;
      turnMs?: number;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.failure = options?.failure ?? null;
    this.attempts = options?.attempts ?? null;
    this.turnMs = options?.turnMs ?? null;
  }
}

function isExpectedTurnTransportFailure(error: unknown): boolean {
  const transportCause = error instanceof Error ? error.cause : undefined;
  return (
    transportCause instanceof TypeError ||
    (transportCause instanceof DOMException &&
      (transportCause.name === "AbortError" ||
        transportCause.name === "TimeoutError"))
  );
}

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
  connectorAccountId: string;
  chatId: string;
  providerThreadId?: string;
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

function personalTelegramConfig(
  env: AppEnv["Bindings"],
): TelegramConnectorConfig {
  return {
    botToken: readEnvString(env, "ELIZA_APP_TELEGRAM_BOT_TOKEN") ?? undefined,
    botId: readEnvString(env, "ELIZA_APP_TELEGRAM_BOT_ID") ?? undefined,
    botUsername:
      readEnvString(env, "ELIZA_APP_TELEGRAM_BOT_USERNAME") ?? undefined,
    webhookSecret:
      readEnvString(env, "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET") ?? undefined,
  };
}

function telegramIdentityFailureReason(
  error: unknown,
): TelegramIdentityAttestationError["reason"] {
  return error instanceof TelegramIdentityAttestationError
    ? error.reason
    : "provider_unavailable";
}

async function requirePersonalTelegramIdentity(
  env: AppEnv["Bindings"],
): Promise<{
  config: TelegramConnectorConfig & {
    botToken: string;
    botId: string;
    botUsername: string;
    webhookSecret: string;
  };
  connectorAccountId: string;
  project: string;
}> {
  const config = personalTelegramConfig(env);
  if (
    !config.botToken ||
    !config.botId ||
    !config.botUsername ||
    !config.webhookSecret
  ) {
    throw new TelegramIdentityAttestationError("not_configured", false);
  }
  await attestTelegramBotIdentity(config);
  const project =
    readEnvString(env, "ELIZA_APP_WEBHOOK_PROJECT") ?? "eliza-app";
  if (!DELIVERY_PROJECT_RE.test(project)) {
    throw new TelegramIdentityAttestationError("configuration_invalid", false);
  }
  return {
    config: config as TelegramConnectorConfig & {
      botToken: string;
      botId: string;
      botUsername: string;
      webhookSecret: string;
    },
    connectorAccountId: await resolveTelegramConnectorAccountId(
      config.botToken,
    ),
    project,
  };
}

/** Fails closed without allocating Telegram delivery state or exposing identity values. */
function personalTelegramIdentityFailureResponse(
  c: AppContext,
  error: unknown,
): Response {
  const reason = telegramIdentityFailureReason(error);
  logger.error("[PersonalTelegramEdge] canonical identity is not ready", {
    reason,
  });
  c.header("X-Eliza-Failure-Stage", "connector_identity");
  c.header("X-Eliza-Failure-Name", "TelegramIdentityAttestationError");
  return c.json(
    {
      success: false,
      error: "Telegram connector identity is not ready",
      code: "telegram_identity_not_ready",
      reason,
    },
    503,
    { "Retry-After": "5" },
  );
}

export async function personalTelegramIdentityFailure(
  c: AppContext,
): Promise<Response | null> {
  try {
    await requirePersonalTelegramIdentity(c.env);
    return null;
  } catch (error) {
    // error-policy:J1 the authenticated gateway boundary returns a sanitized
    // fail-closed identity response before delivery state is allocated.
    return personalTelegramIdentityFailureResponse(c, error);
  }
}

/** Public value-free readiness used by protected release and cutover proofs. */
export async function handlePersonalTelegramIdentityReadiness(
  c: AppContext,
): Promise<Response> {
  try {
    const identity = await requirePersonalTelegramIdentity(c.env);
    return c.json({ status: "attested", project: identity.project });
  } catch (error) {
    // error-policy:J1 the public readiness boundary exposes only the bounded
    // identity reason and never credential or provider details.
    return personalTelegramIdentityFailureResponse(c, error);
  }
}

async function resolveTelegramConnectorAccountId(
  botToken: string,
): Promise<string> {
  // Match the gateway identity contract: the documented decimal prefix is the
  // immutable bot id, while opaque proxy/test credentials remain non-secret.
  const botId = botToken.match(/^(\d{1,20}):/)?.[1];
  return botId ? `bot:${botId}` : `bot:${await sha256Hex(botToken)}`;
}

async function configuredPersonalTelegramScope(
  env: AppEnv["Bindings"],
): Promise<{ project: string; connectorAccountId: string } | null> {
  const project =
    readEnvString(env, "ELIZA_APP_WEBHOOK_PROJECT") ?? "eliza-app";
  const botToken = readEnvString(env, "ELIZA_APP_TELEGRAM_BOT_TOKEN");
  if (!DELIVERY_PROJECT_RE.test(project) || !botToken) return null;
  return {
    project,
    connectorAccountId: await resolveTelegramConnectorAccountId(botToken),
  };
}

async function telegramCanonicalMessageId(
  project: string,
  connectorAccountId: string,
  providerMessageId: string,
): Promise<string> {
  const readable = `telegram:${project}:${connectorAccountId}:${providerMessageId}`;
  if (DELIVERY_MESSAGE_ID_RE.test(readable)) return readable;
  return `telegram:v2:${connectorAccountId}:${await sha256Hex(
    `${project}\0${providerMessageId}`,
  )}`;
}

function telegramDeliveryObjectName(
  project: string,
  senderId: string,
  connectorAccountId?: string,
): string {
  return connectorAccountId
    ? `telegram:${project}:personal-shared:${connectorAccountId}:${senderId}`
    : `telegram:${project}:personal-shared:${senderId}`;
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

/**
 * Binds an authenticated Gateway handoff to the exact Worker-side bot account
 * before the Worker allocates delivery state or performs a provider action.
 */
export async function personalTelegramGatewayConnectorAccountFailure(
  c: AppContext,
): Promise<Response | null> {
  const configuredScope = await configuredPersonalTelegramScope(c.env);
  if (!configuredScope) {
    return c.json(
      { success: false, error: "Telegram connector is not configured" },
      503,
    );
  }
  const presentedHeader = c.req.header(TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER);
  if (
    presentedHeader === undefined &&
    isPersonalTelegramDeliveryEpoch1CompatEnabled(c.env)
  ) {
    logger.warn(
      "[PersonalTelegramEdge] legacy headerless gateway handoff accepted",
      { deliveryEpoch: 1 },
    );
    return null;
  }
  const presentedAccountId = presentedHeader?.trim() ?? "";
  if (
    !TELEGRAM_CONNECTOR_ACCOUNT_RE.test(presentedAccountId) ||
    presentedAccountId !== configuredScope.connectorAccountId
  ) {
    c.header("X-Eliza-Failure-Stage", "connector_account");
    return c.json(
      { success: false, error: "Telegram connector account mismatch" },
      409,
    );
  }
  return null;
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
  const messageId = input.messageId;
  const operation = input.operation;
  const deliveryEpoch = input.deliveryEpoch;
  const connectorAccountId = input.connectorAccountId;
  const legacyEpoch =
    deliveryEpoch === undefined && connectorAccountId === undefined;
  const accountScopedEpoch =
    deliveryEpoch === PERSONAL_TELEGRAM_DELIVERY_EPOCH &&
    typeof connectorAccountId === "string" &&
    TELEGRAM_CONNECTOR_ACCOUNT_RE.test(connectorAccountId);
  if (
    typeof project !== "string" ||
    !DELIVERY_PROJECT_RE.test(project) ||
    typeof senderId !== "string" ||
    !DELIVERY_SENDER_RE.test(senderId) ||
    typeof messageId !== "string" ||
    !DELIVERY_MESSAGE_ID_RE.test(messageId) ||
    (operation !== "mark_uncertain" && operation !== "mark_delivered") ||
    (!legacyEpoch && !accountScopedEpoch)
  ) {
    return c.json({ success: false, error: "Invalid delivery scope" }, 400);
  }
  const configuredScope = await configuredPersonalTelegramScope(c.env);
  if (!configuredScope) {
    return c.json(
      { success: false, error: "Telegram connector is not configured" },
      503,
    );
  }
  if (
    project !== configuredScope.project ||
    (accountScopedEpoch &&
      connectorAccountId !== configuredScope.connectorAccountId)
  ) {
    return c.json({ success: false, error: "Forbidden delivery scope" }, 403);
  }
  if (legacyEpoch && !isPersonalTelegramDeliveryEpoch1CompatEnabled(c.env)) {
    logger.warn(
      "[PersonalTelegramDelivery] legacy epoch reconciliation rejected",
      { deliveryEpoch: 1, operation },
    );
    return c.json(
      {
        success: false,
        error: "Legacy Telegram delivery epoch is disabled",
        code: "LEGACY_DELIVERY_EPOCH_DISABLED",
      },
      409,
    );
  }
  const namespace = c.env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace) {
    return c.json({ success: false, error: "Delivery binding missing" }, 503);
  }
  // Epoch 1 is a temporary, observable rolling-upgrade bridge. Its ambiguous
  // tombstones stay quarantined from epoch 2 and expire after 30 days.
  if (legacyEpoch) {
    logger.warn(
      "[PersonalTelegramDelivery] legacy epoch reconciliation accepted",
      { deliveryEpoch: 1, operation },
    );
  }
  const scopedConnectorAccountId = accountScopedEpoch
    ? configuredScope.connectorAccountId
    : undefined;
  const scopedMessageId = scopedConnectorAccountId
    ? await telegramCanonicalMessageId(
        configuredScope.project,
        scopedConnectorAccountId,
        messageId,
      )
    : messageId;
  const stub = namespace.getByName(
    telegramDeliveryObjectName(
      configuredScope.project,
      senderId,
      scopedConnectorAccountId,
    ),
  );
  const response = await stub.fetch(
    `https://personal-telegram-delivery${PERSONAL_TELEGRAM_DELIVERY_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: scopedMessageId,
        operation,
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
  connectorAccountId: string,
  canonicalMessageId: string,
  event: TelegramConnectorEvent,
): Promise<TelegramDeliveryLedger> {
  const namespace = env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace)
    throw new Error("Personal Telegram delivery binding is missing");
  const stub = namespace.getByName(
    telegramDeliveryObjectName(project, event.senderId, connectorAccountId),
  );
  return {
    async read() {
      const body = await callLedger(stub, canonicalMessageId, "read");
      return body.state === "uncertain" || body.state === "delivered"
        ? body.state
        : null;
    },
    async claimProcessing() {
      return (
        (await callLedger(stub, canonicalMessageId, "claim_processing"))
          .claimed === true
      );
    },
    async releaseProcessing() {
      await callLedger(stub, canonicalMessageId, "release_processing");
    },
    async preparePlan(chunkDigests) {
      const body = await callLedger(stub, canonicalMessageId, "prepare_plan", {
        chunkDigests,
      });
      return body.plan === "prepared" ? "prepared" : "conflict";
    },
    async readChunk(chunkIndex, chunkDigest) {
      const body = await callLedger(stub, canonicalMessageId, "read_chunk", {
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
          await callLedger(stub, canonicalMessageId, "claim_chunk", {
            chunkIndex,
            chunkDigest,
          })
        ).claimed === true
      );
    },
    async releaseChunk(chunkIndex, chunkDigest) {
      await callLedger(stub, canonicalMessageId, "release_chunk", {
        chunkIndex,
        chunkDigest,
      });
    },
    async markChunkDelivered(chunkIndex, chunkDigest, providerMessageId) {
      await callLedger(stub, canonicalMessageId, "mark_chunk_delivered", {
        chunkIndex,
        chunkDigest,
        providerMessageId,
      });
    },
    async markDelivered() {
      await callLedger(stub, canonicalMessageId, "mark_delivered");
    },
  };
}

async function readEdgeReceipt(
  env: AppEnv["Bindings"],
  project: string,
  connectorAccountId: string,
  canonicalMessageId: string,
  event: TelegramConnectorEvent,
): Promise<{ acceptedAt: string; providerMessageIds: string[] } | null> {
  const namespace = env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace) return null;
  const stub = namespace.getByName(
    telegramDeliveryObjectName(project, event.senderId, connectorAccountId),
  );
  const body = await callLedger(stub, canonicalMessageId, "read_receipt");
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
  if (
    input.providerThreadId !== undefined &&
    (!DELIVERY_THREAD_RE.test(input.providerThreadId) ||
      !Number.isSafeInteger(Number(input.providerThreadId)))
  ) {
    return {
      ok: false,
      acceptance: "not_accepted",
      message: "Telegram reminder topic is invalid",
    };
  }
  let identity: Awaited<ReturnType<typeof requirePersonalTelegramIdentity>>;
  try {
    identity = await requirePersonalTelegramIdentity(env);
  } catch (error) {
    // error-policy:J1 proactive delivery translates an unattested identity to
    // an explicit not-accepted result before ledger or provider work.
    return {
      ok: false,
      acceptance: "not_accepted",
      message: `Telegram connector identity is not ready (${telegramIdentityFailureReason(error)})`,
    };
  }
  const configuredScope = await configuredPersonalTelegramScope(env);
  if (
    !configuredScope ||
    configuredScope.project !== input.project ||
    !TELEGRAM_CONNECTOR_ACCOUNT_RE.test(input.connectorAccountId) ||
    configuredScope.connectorAccountId !== input.connectorAccountId
  ) {
    return {
      ok: false,
      acceptance: "not_accepted",
      message:
        "Telegram connector account no longer matches the reminder destination",
    };
  }
  const event: TelegramConnectorEvent = {
    platform: "telegram",
    messageId: input.idempotencyKey,
    platformRecordId: input.idempotencyKey,
    chatId: input.chatId,
    chatType: input.chatId.startsWith("-") ? "supergroup" : "private",
    senderId: input.chatId,
    text: "",
    isCommand: false,
    ...(input.providerThreadId
      ? { providerThreadId: input.providerThreadId }
      : {}),
    rawPayload: { source: "shared-reminder" },
  };
  try {
    const connectorAccountId = input.connectorAccountId;
    const canonicalMessageId = await telegramCanonicalMessageId(
      input.project,
      connectorAccountId,
      event.messageId,
    );
    const ledger = await edgeLedger(
      env,
      input.project,
      connectorAccountId,
      canonicalMessageId,
      event,
    );
    const outcome = await executeTelegramDelivery(ledger, async (hooks) => {
      await sendTelegramReply(
        identity.config,
        event,
        input.text,
        logger,
        hooks,
      );
    });
    if (outcome === "uncertain" || outcome === "in_progress") {
      return {
        ok: false,
        acceptance: "unknown",
        message: `Telegram reminder delivery is ${outcome}`,
      };
    }
    const receipt = await readEdgeReceipt(
      env,
      input.project,
      connectorAccountId,
      canonicalMessageId,
      event,
    );
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
  connectorAccountId: string,
  canonicalMessageId: string,
  event: TelegramConnectorEvent,
  voiceNote?: Awaited<ReturnType<typeof resolveTelegramVoiceNote>>,
): Record<string, unknown> {
  return {
    platform: "telegram",
    project,
    connectorAccountId,
    chatId: event.chatId,
    telegramUserId: event.senderId,
    displayName: event.senderName,
    messageId: canonicalMessageId,
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
  const startedAt = performance.now();
  let observedAttempts = 0;
  let result: Awaited<ReturnType<typeof executeResponseAttempts>>;
  try {
    result = await executeResponseAttempts({
      maxAttempts,
      replayPolicy: "idempotent",
      honorExplicitRetryable: true,
      request: () => deps.runTurn(body, traceId, c.env, c.executionCtx),
      retryStatuses: !event.voiceNote,
      retryTransport: !event.voiceNote,
      retryDelayCapMs: RETRY_DELAY_CAP_MS,
      reportObservationError: (error, observation) => {
        logger.warn("[PersonalTelegramEdge] attempt observation failed", {
          traceId,
          messageId: event.messageId,
          attempt: observation.attempt,
          errorName: safeObservedErrorName(error),
        });
      },
      observe: (observation) => {
        observedAttempts = observation.attempt;
        const response = observation.response;
        const failure = response
          ? readPersonalSharedFailureMetadata(response)
          : null;
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
          failureStage: failure?.stage ?? null,
          failureName: failure?.name ?? null,
          failureCauseName: failure?.causeName ?? null,
          ...(observation.error
            ? {
                errorName: safeObservedErrorName(observation.error),
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
  } catch (error) {
    if (!isExpectedTurnTransportFailure(error)) throw error;
    // error-policy:J2 preserve the exact observed retry receipt when a known
    // transport failure exhausts before the caller can receive a result.
    throw new PersonalTelegramPreEgressError(
      "Personal Shared turn transport failed before egress",
      {
        cause: error,
        attempts: observedAttempts,
        turnMs: Math.round(performance.now() - startedAt),
      },
    );
  }
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
  const configured = personalTelegramConfig(c.env);
  if (!configured.webhookSecret) {
    logger.error("[PersonalTelegramEdge] connector secret is not configured");
    return c.json(
      { success: false, error: "Telegram connector is not configured" },
      503,
    );
  }
  if (!verifyTelegramWebhook(c.req.raw, configured.webhookSecret)) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  let identity: Awaited<ReturnType<typeof requirePersonalTelegramIdentity>>;
  try {
    identity = await requirePersonalTelegramIdentity(c.env);
  } catch (error) {
    // error-policy:J1 the provider webhook boundary fails closed with a
    // sanitized identity response before parsing or allocating delivery state.
    return personalTelegramIdentityFailureResponse(c, error);
  }
  const rawBody = await c.req.text();
  const event = parseTelegramWebhook(rawBody, logger);
  if (!event) return c.json({ ok: true });
  const providerToWorkerMs =
    event.providerSentAtMs === undefined
      ? null
      : Date.now() - event.providerSentAtMs;
  const { project, connectorAccountId } = identity;
  const config = identity.config;
  const canonicalMessageId = await telegramCanonicalMessageId(
    project,
    connectorAccountId,
    event.messageId,
  );
  const ledger = await edgeLedger(
    c.env,
    project,
    connectorAccountId,
    canonicalMessageId,
    event,
  );

  try {
    let turnMs = 0;
    let egressMs = 0;
    let attempts = 0;
    let fallbackDelivered = false;
    const outcome = await executeTelegramDelivery(
      ledger,
      async (deliveryHooks) => {
        const stopTyping = event.membershipChange
          ? () => undefined
          : startTyping(config, event);
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
          let reply: string | null = null;
          let preEgressError: PersonalTelegramPreEgressError | null = null;
          try {
            let voiceNote:
              | Awaited<ReturnType<typeof resolveTelegramVoiceNote>>
              | undefined;
            try {
              voiceNote = event.voiceNote
                ? await resolveTelegramVoiceNote(config, event)
                : undefined;
            } catch (error) {
              // error-policy:J2 provider-backed voice resolution failures gain
              // explicit pre-egress context while preserving their cause.
              throw new PersonalTelegramPreEgressError(
                "Telegram voice note resolution failed before egress",
                { cause: error },
              );
            }
            const turn = await runTurnWithRetry(
              c,
              deps,
              deliveryBody(
                project,
                connectorAccountId,
                canonicalMessageId,
                event,
                voiceNote,
              ),
              event,
              traceId,
            );
            turnMs = turn.turnMs;
            attempts = turn.attempts;
            if (!turn.response.ok) {
              const failure = readPersonalSharedFailureMetadata(turn.response);
              try {
                await turn.response.body?.cancel();
              } catch (error) {
                // error-policy:J6 response cleanup cannot replace the typed
                // pre-egress failure already established by the status.
                logger.warn(
                  "[PersonalTelegramEdge] turn failure body cleanup failed",
                  {
                    traceId,
                    platform: "telegram",
                    messageId: event.messageId,
                    status: turn.response.status,
                    errorName: safeObservedErrorName(error),
                  },
                );
              }
              throw new PersonalTelegramPreEgressError(
                `Personal Shared turn failed before egress (${turn.response.status})`,
                { failure },
              );
            } else {
              let payload: unknown;
              try {
                payload = await turn.response.json();
              } catch (error) {
                // error-policy:J3 a successful response remains untrusted
                // until its JSON contract parses before provider egress.
                throw new PersonalTelegramPreEgressError(
                  "Personal Shared turn returned invalid JSON",
                  { cause: error },
                );
              }
              const candidate =
                payload && typeof payload === "object" && "data" in payload
                  ? (payload.data as { reply?: unknown } | null)?.reply
                  : undefined;
              if (typeof candidate !== "string") {
                throw new PersonalTelegramPreEgressError(
                  "Personal Shared edge turn returned no reply",
                );
              }
              reply = candidate;
            }
          } catch (error) {
            // error-policy:J4 only the typed, expected pre-egress failure
            // shape may degrade to the explicit private Telegram reply.
            if (!(error instanceof PersonalTelegramPreEgressError)) throw error;
            preEgressError = error;
            if (error.attempts !== null) attempts = error.attempts;
            if (error.turnMs !== null) turnMs = error.turnMs;
          }
          if (preEgressError) {
            if (event.chatType !== "private" || event.membershipChange) {
              // error-policy:J2 add the non-private delivery context while
              // preserving the exact typed pre-egress failure as the cause.
              throw new PersonalTelegramPreEgressError(
                "Personal Shared non-private turn failed before egress",
                {
                  cause: preEgressError,
                  failure: preEgressError.failure,
                },
              );
            }
            const fallbackFailure = preEgressError.failure;
            logger.warn(
              "[PersonalTelegramEdge] pre-egress turn failed; sending safe fallback",
              {
                traceId,
                platform: "telegram",
                messageId: event.messageId,
                attempts,
                status: fallbackFailure?.status ?? null,
                failureStage: fallbackFailure?.stage ?? null,
                failureName: fallbackFailure?.name ?? null,
                failureCauseName: fallbackFailure?.causeName ?? null,
                retryable: fallbackFailure?.retryable ?? false,
                preEgressErrorName: safeObservedErrorName(preEgressError.cause),
              },
            );
            const egressStartedAt = performance.now();
            await sendTelegramReply(
              config,
              event,
              PERSONAL_SHARED_FAILURE_REPLY,
              logger,
              deliveryHooks,
            );
            egressMs = Math.round(performance.now() - egressStartedAt);
            fallbackDelivered = true;
            return;
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
      fallbackDelivered,
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
