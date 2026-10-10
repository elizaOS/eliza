/** Handles authenticated connector webhooks from verification through reply delivery. */

import {
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/cloud-services-common";
import {
  executeTelegramDelivery,
  TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER,
  type TelegramDeliveryHooks,
  type TelegramDeliveryLedger,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "@elizaos/cloud-services-common/telegram";
import {
  executeResponseAttempts,
  PERSONAL_SHARED_FAILURE_REPLY,
  type PersonalSharedFailureMetadata,
  personalSharedFailureReply,
  personalSharedNoResponseFailure,
  type ResponseAttemptsResult,
  readPersonalSharedFailureMetadata,
} from "@elizaos/cloud-services-common/transport";
import type { NetworkServiceClient } from "@elizaos/plugin-network/client";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import type {
  ChatEvent,
  Platform,
  PlatformAdapter,
  WebhookConfig,
} from "./adapters/types";
import { PlatformDeliveryError } from "./adapters/types";
import { reacquireAuthHeader } from "./auth";
import { resolveConnectorAccountId } from "./connector-account";
import {
  CUTOVER_HOLD_CODES,
  type CutoverHoldSignal,
  type HeldWebhook,
  type HeldWebhookOutcome,
  holdWebhookForCutover,
} from "./cutover-hold";
import { tryConfirmIdentityLink } from "./identity-link";
import { logger } from "./logger";
import {
  handleNetworkInboundCompliance,
  isNetworkAddressOptedOut,
  isNetworkProject,
  type NetworkConsentLedger,
  type NetworkInboundCompliance,
  redisNetworkConsentLedger,
  sendWithTwilioReplyFence,
} from "./network-compliance";
import {
  type NetworkOpenTurn,
  networkServiceFromEnv,
  runNetworkServiceTurn,
  takeoverAppliesTo,
} from "./network-service";
import type { GatewayRedis } from "./redis";
import {
  forwardToServer,
  refreshKedaActivity,
  resolveAgentServer,
  resolveIdentity,
} from "./server-router";
import {
  isCanonicalTelegramProject,
  requireCanonicalTelegramIdentity,
  telegramIdentityNotReadyResponse,
} from "./telegram-identity";
import { resolveWebhookConfig } from "./webhook-config";

const PERSONAL_SHARED_DELIVERY_LEASE_MS = 90_000;
// Must outlive the 75s non-idempotent message-forward budget plus Telegram
// egress. Otherwise a provider retry can reclaim the update while the first
// worker is still generating and execute the same user turn twice.
const PERSONAL_SHARED_ATTEMPTS = 3;
const PERSONAL_SHARED_RETRY_DELAY_CAP_MS = 5_000;
const PROCESSING_TTL_SECONDS = 120;
const TELEGRAM_DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const PERSONAL_TELEGRAM_DELIVERY_EPOCH = 2;
const CONNECTOR_PROCESSING = "processing";
const CONNECTOR_DELIVERED = "delivered";
const CONNECTOR_UNCERTAIN = "uncertain";
const TELEGRAM_EGRESS_STARTED = "egress_started";
const TELEGRAM_DELIVERED = "delivered";
const TELEGRAM_TYPING_REFRESH_MS = 4_000;
const PERSONAL_SHARED_VOICE_TIMEOUT_MS = 90_000;
// Seedance video generation is selected by the runtime action planner, after
// the gateway has forwarded the turn, so ingress cannot reliably classify a
// text-only video request. Keep every Personal Shared cloud turn alive long
// enough for a short queued render; image attachments use the same budget for
// vision followed by image-to-video generation.
export const PERSONAL_SHARED_TURN_TIMEOUT_MS = 15 * 60_000;
// Mirrors the Worker binding of the same name. Both sides must be enabled
// together: the gateway only forwards Blooio media URLs (and adopts the
// long-turn timeout/retry posture they require) when this is exactly "true",
// so a dark Worker never receives media it would not describe and a dark
// gateway never trades retries for a vision stage that does not run.
const INBOUND_MEDIA_VISION_ENV = "ELIZA_APP_INBOUND_MEDIA_VISION";

function inboundMediaVisionEnabled(): boolean {
  return process.env[INBOUND_MEDIA_VISION_ENV]?.trim() === "true";
}
const ELIZA_TRACE_ID_HEADER = "X-Eliza-Trace-Id";
const OPAQUE_TRACE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ZERO_TRACE_ID = "0".repeat(32);
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

class PersonalSharedPreEgressError extends Error {
  override readonly name = "PersonalSharedPreEgressError";
  readonly failure: PersonalSharedFailureMetadata | null;
  /** Cloud refused the turn before execution because a cutover holds it. */
  readonly hold: CutoverHoldSignal | null;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      failure?: PersonalSharedFailureMetadata | null;
      hold?: CutoverHoldSignal | null;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.failure = options?.failure ?? null;
    this.hold = options?.hold ?? null;
  }
}

/** Read Cloud's explicit pre-execution cutover hold from a refused turn. */
async function readCutoverHold(
  response: Response,
): Promise<CutoverHoldSignal | null> {
  const payload = (await response.json()) as {
    code?: unknown;
    retryable?: unknown;
  } | null;
  if (
    response.status !== 503 ||
    payload?.retryable !== true ||
    typeof payload.code !== "string" ||
    !CUTOVER_HOLD_CODES.has(payload.code)
  ) {
    return null;
  }
  const retryAfter = Number.parseInt(
    response.headers.get("Retry-After") ?? "",
    10,
  );
  return {
    code: payload.code,
    retryAfterSeconds:
      Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

class PersonalSharedRecoverablePostEgressError extends Error {
  override readonly name = "PersonalSharedRecoverablePostEgressError";
}

interface HandlerDeps {
  redis: GatewayRedis;
  cloudBaseUrl: string;
  deliveryAuthoritySecret?: string;
  getAuthHeader: () => { Authorization: string };
  reacquireAuthHeader?: () => Promise<Record<string, string>>;
  /** Network consent ledger; defaults to the Redis ledger on `redis`. */
  networkConsentLedger?: NetworkConsentLedger;
  /**
   * The Network service (takeover). Defaults to `networkServiceFromEnv()`;
   * `null` forces the legacy gateway-only keyword path.
   */
  networkService?: Pick<NetworkServiceClient, "turn" | "turnReceipt"> | null;
}

function networkConsentLedger(deps: HandlerDeps): NetworkConsentLedger {
  return deps.networkConsentLedger ?? redisNetworkConsentLedger(deps.redis);
}

interface PersonalSharedDeliveryTiming {
  cloudMs: number;
  cloudAttempts: number;
  egressMs: number;
  cloudServerTiming: string | null;
}

interface GroupDeliveryAuthority {
  bindingId: string;
  ownerUserId: string;
  personalAgentId: string;
  version: number;
  requiresAllAdultsConsent?: boolean;
}

type GroupDeliveryDirective =
  | { kind: "control" }
  | { kind: "binding"; authority: GroupDeliveryAuthority };

function parseGroupDeliveryDirective(
  value: unknown,
): GroupDeliveryDirective | null {
  if (!value || typeof value !== "object") return null;
  const directive = value as Record<string, unknown>;
  if (directive.kind === "control") return { kind: "control" };
  const authority = directive.authority;
  if (
    directive.kind !== "binding" ||
    !authority ||
    typeof authority !== "object"
  ) {
    return null;
  }
  const candidate = authority as Record<string, unknown>;
  if (
    typeof candidate.bindingId !== "string" ||
    typeof candidate.ownerUserId !== "string" ||
    typeof candidate.personalAgentId !== "string" ||
    typeof candidate.version !== "number" ||
    !Number.isSafeInteger(candidate.version) ||
    candidate.version <= 0 ||
    (candidate.requiresAllAdultsConsent !== undefined &&
      typeof candidate.requiresAllAdultsConsent !== "boolean")
  ) {
    return null;
  }
  return {
    kind: "binding",
    authority: {
      bindingId: candidate.bindingId,
      ownerUserId: candidate.ownerUserId,
      personalAgentId: candidate.personalAgentId,
      version: candidate.version,
      ...(candidate.requiresAllAdultsConsent === undefined
        ? {}
        : {
            requiresAllAdultsConsent: candidate.requiresAllAdultsConsent,
          }),
    },
  };
}

function parsePersonalSharedMediaUrls(
  data: Record<string, unknown> | null,
  preserveAll = false,
): string[] {
  if (!Array.isArray(data?.mediaUrls)) return [];
  const urls = data.mediaUrls.flatMap((value) => {
    if (typeof value !== "string") return [];
    try {
      const url = new URL(value.trim());
      return url.protocol === "https:" ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
  return preserveAll ? [...new Set(urls)] : urls.slice(0, 4);
}

interface MessageTraceContext {
  traceId: string;
  gatewayReceivedAtMs: number;
}

async function sendReplyWithRequiredReceipt(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  text: string,
  deliveryHooks?: TelegramDeliveryHooks,
  mediaUrls?: readonly string[],
): Promise<string[]> {
  if (!adapter.sendReplyWithReceipt) {
    throw new PlatformDeliveryError(
      `${adapter.platform} adapter does not expose provider receipts`,
      "failed",
      "DELIVERY_RECEIPT_UNSUPPORTED",
      false,
    );
  }
  const receipt = await adapter.sendReplyWithReceipt(
    config,
    event,
    text,
    deliveryHooks,
    mediaUrls,
  );
  const providerMessageIds = receipt.providerMessageIds
    .map((id) => id.trim())
    .filter(Boolean);
  if (providerMessageIds.length === 0) {
    throw new PlatformDeliveryError(
      `${adapter.platform} accepted delivery without a message receipt`,
      "uncertain",
      "DELIVERY_RECEIPT_INVALID",
      false,
    );
  }
  return providerMessageIds;
}

/**
 * Direct (non-group) reply egress. A Network Twilio reply goes through the
 * Redis tombstone fence so a reopened webhook cannot send it twice; every
 * other project and platform keeps the unfenced path unchanged.
 */
async function sendDirectReply(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  text: string,
  deliveryHooks?: TelegramDeliveryHooks,
  mediaUrls?: readonly string[],
): Promise<void> {
  if (adapter.platform === "twilio" && isNetworkProject(project)) {
    const outcome = await sendWithTwilioReplyFence(
      deps.redis,
      project,
      event.messageId,
      () =>
        sendReplyWithRequiredReceipt(
          adapter,
          config,
          event,
          text,
          deliveryHooks,
          mediaUrls,
        ),
      (error) =>
        error instanceof PlatformDeliveryError &&
        error.deliveryStatus === "failed",
    );
    if (outcome === "replayed") {
      logger.warn("Network Twilio reply already claimed; not resending", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
      });
    }
    return;
  }
  await sendReplyWithRequiredReceipt(
    adapter,
    config,
    event,
    text,
    deliveryHooks,
    mediaUrls,
  );
}

async function reconcileLegacyTelegramDelivery(
  deps: HandlerDeps,
  project: string,
  connectorAccountId: string,
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
        deliveryEpoch: PERSONAL_TELEGRAM_DELIVERY_EPOCH,
        project,
        connectorAccountId,
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
  connectorAccountId: string,
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
      connectorAccountId,
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
          [TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER]: connectorAccountId,
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
    } else if (
      response.status === 409 &&
      response.headers.get("X-Eliza-Failure-Stage") === "connector_account"
    ) {
      // The Worker rejected the handoff before provider egress because this
      // gateway resolved a different bot account. Reopen only this explicit,
      // pre-egress failure so a corrected gateway/config can retry the update.
      await deps.redis.del(dedupKey);
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
    encoded: unknown,
  ): { state: TelegramDeliveryState; providerMessageId?: string } | null => {
    if (encoded === "uncertain" || encoded === "delivered") {
      return { state: encoded };
    }
    if (!encoded) return null;
    try {
      // Every GatewayRedis adapter JSON-parses on get(), so a stored JSON
      // record arrives already parsed; accept both shapes, the way
      // parseHeldWebhook in cutover-hold.ts does.
      const parsed = (
        typeof encoded === "string" ? JSON.parse(encoded) : encoded
      ) as {
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
  // The stored plan reads back as an array through the JSON-parsing
  // adapters and as its JSON string through a raw one; compare by content
  // either way, or an identical plan re-registration always conflicts.
  const planMatches = (
    existing: unknown,
    chunkDigests: readonly string[],
  ): boolean =>
    Array.isArray(existing)
      ? existing.length === chunkDigests.length &&
        existing.every((digest, index) => digest === chunkDigests[index])
      : existing === JSON.stringify(chunkDigests);
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
      const existing = await redis.get(planKey);
      if (existing !== null) {
        return planMatches(existing, chunkDigests) ? "prepared" : "conflict";
      }
      const claimed = await redis.set(planKey, encoded, {
        nx: true,
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
      if (claimed) return "prepared";
      return planMatches(await redis.get(planKey), chunkDigests)
        ? "prepared"
        : "conflict";
    },
    async readChunk(chunkIndex, chunkDigest) {
      return (
        decodeChunk(await redis.get(chunkKey(chunkIndex, chunkDigest)))
          ?.state ?? null
      );
    },
    async readChunkProviderMessageId(chunkIndex, chunkDigest) {
      return (
        decodeChunk(await redis.get(chunkKey(chunkIndex, chunkDigest)))
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

  if (
    adapter.platform === "telegram" &&
    isCanonicalTelegramProject(project, agentId)
  ) {
    try {
      await requireCanonicalTelegramIdentity(config);
    } catch (error) {
      // error-policy:J1 the authenticated provider boundary returns a
      // value-safe failure before parsing, deduplication, or provider work.
      return telegramIdentityNotReadyResponse(error);
    }
  }

  const event = await adapter.extractEvent(rawBody, config);
  if (!event) {
    return ackResponse(adapter.platform);
  }

  if (adapter.platform === "blooio") event.traceId = trace.traceId;

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
        const connectorAccountId = resolveConnectorAccountId(
          "telegram",
          config,
        );
        if (!connectorAccountId) {
          throw new Error("Telegram connector account identity is missing");
        }
        return forwardPersonalTelegramToEdge(
          request,
          rawBody,
          deps,
          project,
          connectorAccountId,
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

  if (
    isNetworkProject(project) &&
    (adapter.platform === "blooio" || adapter.platform === "twilio")
  ) {
    // A retry must retain the exact service request body. This is metadata of
    // the existing authenticated ingress ledger, not a second turn cache.
    const timeKey = `${dedupKey}:received-at`;
    await redis.set(timeKey, String(event.providerSentAtMs ?? Date.now()), {
      nx: true,
      ex: TELEGRAM_DELIVERY_TTL_SECONDS,
    });
    const retained = Number(await redis.get(timeKey));
    if (!Number.isSafeInteger(retained) || retained <= 0)
      throw new Error("Network ingress timestamp unavailable");
    event.gatewayReceivedAtMs = retained;
  }
  const priorDeliveryState = await redis.get<string>(dedupKey);
  if (priorDeliveryState) {
    if (
      priorDeliveryState === CONNECTOR_UNCERTAIN ||
      priorDeliveryState === "1"
    ) {
      logger.error("Webhook delivery outcome is uncertain; refusing replay", {
        platform: adapter.platform,
        messageId: event.messageId,
        dedupKey,
      });
      return new Response(
        JSON.stringify({ error: "delivery outcome uncertain" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (priorDeliveryState === CONNECTOR_PROCESSING) {
      return new Response(JSON.stringify({ error: "delivery in progress" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    logger.debug("Duplicate webhook skipped", {
      platform: adapter.platform,
      messageId: event.messageId,
      dedupKey,
    });
    return ackResponse(adapter.platform);
  }

  const isNew = await redis.set(dedupKey, CONNECTOR_PROCESSING, {
    nx: true,
    // A worker can disappear after provider acceptance but before recording a
    // receipt. Keep that orphaned claim for the terminal ledger lifetime; a
    // short lease would eventually replay an outcome that is necessarily
    // uncertain. Explicit idempotent pre-egress failures delete the claim.
    ex: TELEGRAM_DELIVERY_TTL_SECONDS,
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

  processMessage(adapter, config, event, deps, project, trace, agentId)
    .then(async () => {
      await redis.set(dedupKey, CONNECTOR_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
    })
    .catch(async (err) => {
      if (
        err instanceof PersonalSharedPreEgressError &&
        err.hold &&
        !agentId &&
        isPersonalElizaTransport(adapter.platform)
      ) {
        try {
          // The provider already received its acknowledgement and will not
          // retry, so a cutover hold parks the turn durably instead of
          // reopening the webhook (#22934).
          await holdWebhookForCutover(
            redis,
            {
              dedupKey,
              platform: adapter.platform,
              project,
              traceId: trace.traceId,
              event,
              code: err.hold.code,
            },
            err.hold,
          );
          logger.warn("Personal connector turn held for Dedicated cutover", {
            project,
            platform: adapter.platform,
            messageId: event.messageId,
            traceId: trace.traceId,
            holdCode: err.hold.code,
          });
          return;
        } catch (holdError) {
          // error-policy:J7 the hold could not be persisted; fall through to
          // the ordinary pre-egress handling so the failure stays visible.
          logger.error("Failed to hold personal connector turn for cutover", {
            error:
              holdError instanceof Error
                ? holdError.message
                : String(holdError),
            project,
            platform: adapter.platform,
            messageId: event.messageId,
          });
        }
      }
      await settleAcknowledgedTurnFailure(
        adapter,
        config,
        event,
        deps,
        project,
        trace.traceId,
        dedupKey,
        err,
        agentId,
      );
    });

  return ackResponse(adapter.platform);
}

/**
 * Settle an acknowledged turn that failed in the background, on its first
 * delivery or after a cutover hold. The provider already received its
 * acknowledgement and will not retry, so a Personal Shared direct turn that
 * failed before any egress gets the same notice a private Telegram turn gets.
 * A Network turn is excluded: its consent state can be unknown here.
 */
async function settleAcknowledgedTurnFailure(
  adapter: PlatformAdapter,
  config: WebhookConfig,
  event: ChatEvent,
  deps: HandlerDeps,
  project: string,
  traceId: string,
  dedupKey: string,
  err: unknown,
  agentId?: string,
): Promise<void> {
  let failure: unknown = err;
  if (
    err instanceof PersonalSharedPreEgressError &&
    !agentId &&
    isPersonalElizaTransport(adapter.platform) &&
    !isNetworkProject(project) &&
    isDirectChat(event)
  ) {
    logger.warn("Personal Shared turn failed; delivering failure notice", {
      project,
      platform: adapter.platform,
      messageId: event.messageId,
      traceId,
      error: err.message,
      status: err.failure?.status ?? null,
      failureStage: err.failure?.stage ?? null,
      failureName: err.failure?.name ?? null,
      failureCauseName: err.failure?.causeName ?? null,
      retryable: err.failure?.retryable ?? false,
    });
    try {
      await sendDirectReply(
        adapter,
        config,
        event,
        deps,
        project,
        personalSharedFailureReply(err.failure),
      );
      await deps.redis.set(dedupKey, CONNECTOR_DELIVERED, {
        ex: TELEGRAM_DELIVERY_TTL_SECONDS,
      });
      return;
    } catch (noticeError) {
      // error-policy:J2 the turn failure is logged above; the ledger now
      // records the outcome of the notice send, which is the only egress.
      failure = noticeError;
    }
  }
  await settleBackgroundDeliveryFailure(deps.redis, failure, {
    dedupKey,
    project,
    platform: adapter.platform,
    messageId: event.messageId,
    traceId,
  });
}

/**
 * Terminal ledger handling for an acknowledged webhook whose background
 * processing failed: an idempotent pre-egress failure clears the delivery
 * claim, and anything that may have reached the provider is recorded as
 * uncertain. Blooio and Twilio were acknowledged before processing and do not
 * retry, so clearing the claim does not by itself recover the turn.
 */
async function settleBackgroundDeliveryFailure(
  redis: GatewayRedis,
  err: unknown,
  context: {
    dedupKey: string;
    project: string;
    platform: Platform;
    messageId: string;
    traceId: string;
  },
): Promise<void> {
  const { dedupKey, project, platform, messageId, traceId } = context;
  logger.error("Background message processing failed", {
    error: err instanceof Error ? err.message : String(err),
    project,
    platform,
    messageId,
    traceId,
  });
  if (
    err instanceof PersonalSharedPreEgressError ||
    err instanceof PersonalSharedRecoverablePostEgressError ||
    (err instanceof PlatformDeliveryError && err.deliveryStatus === "failed")
  ) {
    try {
      // Clearing the claim is safe if the same event arrives again. The
      // Shared endpoint is idempotent, including its pooled-key media
      // enrichment: the Worker keys a durable description record by the
      // forwarded `<platform>:<project>:<messageId>`, so a second delivery
      // reuses the stored description instead of re-spending. Blooio also
      // keys provider egress by the inbound message id, so it does not send
      // a second text.
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
        platform,
        messageId,
      });
    }
    return;
  }
  try {
    // A generic failure can occur after the provider accepted the reply.
    // Persist ambiguity and refuse replay rather than converting a lost
    // receipt into a duplicate user-visible message.
    await redis.set(dedupKey, CONNECTOR_UNCERTAIN, {
      ex: TELEGRAM_DELIVERY_TTL_SECONDS,
    });
  } catch (ledgerError) {
    // error-policy:J7 The provider result is already ambiguous; retain the
    // original processing claim and surface the ledger failure separately.
    logger.error("Failed to persist uncertain webhook delivery", {
      error:
        ledgerError instanceof Error
          ? ledgerError.message
          : String(ledgerError),
      project,
      platform,
      messageId,
    });
  }
}

/**
 * Redeliver one webhook held for cutover with its original message identity.
 * A renewed hold is returned to the drainer; every other outcome settles the
 * dedup ledger exactly as the original background delivery would have.
 */
export async function redeliverHeldWebhook(
  held: HeldWebhook,
  adapter: PlatformAdapter,
  deps: HandlerDeps,
): Promise<HeldWebhookOutcome> {
  const { redis, cloudBaseUrl, getAuthHeader } = deps;
  const reauth = deps.reacquireAuthHeader ?? reacquireAuthHeader;
  let config: WebhookConfig | null = null;
  try {
    config = await resolveWebhookConfig(
      redis,
      cloudBaseUrl,
      getAuthHeader(),
      adapter.platform,
      held.project,
      held.agentId,
      reauth,
    );
    if (!config) {
      throw new PersonalSharedPreEgressError(
        "held connector webhook is no longer configured",
      );
    }
    await processMessage(
      adapter,
      config,
      held.event,
      deps,
      held.project,
      { traceId: held.traceId, gatewayReceivedAtMs: held.heldAt },
      held.agentId,
    );
  } catch (err) {
    // The provider already acknowledged this event. A transient transport or
    // pre-execution failure must stay in the durable retry queue; reopening
    // the provider dedup key cannot cause a provider retry after its ACK. A
    // failure Cloud classified as not retryable would only be refused again
    // until the hold budget ran out, so it settles like the first delivery,
    // including the failure notice to the sender.
    if (
      err instanceof PersonalSharedPreEgressError &&
      (err.hold !== null || err.failure?.retryable !== false)
    ) {
      return {
        kind: "held",
        signal: err.hold ?? { code: held.code, retryAfterSeconds: null },
      };
    }
    if (config) {
      await settleAcknowledgedTurnFailure(
        adapter,
        config,
        held.event,
        deps,
        held.project,
        held.traceId,
        held.dedupKey,
        err,
        held.agentId,
      );
    } else {
      await settleBackgroundDeliveryFailure(redis, err, {
        dedupKey: held.dedupKey,
        project: held.project,
        platform: adapter.platform,
        messageId: held.event.messageId,
        traceId: held.traceId,
      });
    }
    return { kind: "released" };
  }
  await redis.set(held.dedupKey, CONNECTOR_DELIVERED, {
    ex: TELEGRAM_DELIVERY_TTL_SECONDS,
  });
  logger.info("Held personal connector turn delivered after cutover", {
    project: held.project,
    platform: adapter.platform,
    messageId: held.event.messageId,
    traceId: held.traceId,
    heldForMs: Date.now() - held.heldAt,
    attempts: held.attempts + 1,
  });
  return { kind: "delivered" };
}

/**
 * Release a hold that outlived the cutover budget. The turn was never
 * executed and the provider will not retry, so the sender gets the failure
 * notice through the same handling as a first-delivery failure.
 */
export async function releaseExpiredHeldWebhook(
  held: HeldWebhook,
  adapter: PlatformAdapter,
  deps: HandlerDeps,
): Promise<void> {
  logger.error("Held personal connector turn exceeded the cutover budget", {
    project: held.project,
    platform: held.platform,
    messageId: held.event.messageId,
    traceId: held.traceId,
    heldForMs: Date.now() - held.heldAt,
    holdCode: held.code,
    operatorAction:
      "inspect the Dedicated target's attestation; the turn was never executed",
  });
  const expired = new PersonalSharedPreEgressError("cutover hold expired");
  const config = await resolveWebhookConfig(
    deps.redis,
    deps.cloudBaseUrl,
    deps.getAuthHeader(),
    adapter.platform,
    held.project,
    held.agentId,
    deps.reacquireAuthHeader ?? reacquireAuthHeader,
  );
  if (!config) {
    await settleBackgroundDeliveryFailure(deps.redis, expired, {
      dedupKey: held.dedupKey,
      project: held.project,
      platform: adapter.platform,
      messageId: held.event.messageId,
      traceId: held.traceId,
    });
    return;
  }
  await settleAcknowledgedTurnFailure(
    adapter,
    config,
    held.event,
    deps,
    held.project,
    held.traceId,
    held.dedupKey,
    expired,
    held.agentId,
  );
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

  // The Network takeover: a direct message goes to the Network service's
  // deterministic loop first (routing, STOP/HELP/START, join, onboarding).
  // A handled turn is answered here with no model call; an open turn carries
  // the service's member context into the agent turn.
  let networkTurn: NetworkOpenTurn | undefined;
  const networkService =
    deps.networkService === undefined
      ? networkServiceFromEnv()
      : deps.networkService;
  const isDirect = !(
    event.chatType === "group" || event.chatType === "supergroup"
  );
  if (
    isNetworkProject(project) &&
    networkService &&
    isDirect &&
    !event.membershipChange &&
    takeoverAppliesTo(event.senderId)
  ) {
    let outcome: Awaited<ReturnType<typeof runNetworkServiceTurn>>;
    try {
      outcome = await runNetworkServiceTurn(
        networkService,
        networkConsentLedger(deps),
        project,
        event,
      );
    } catch (error) {
      // error-policy:J2 nothing has been sent. A provider that retries gets
      // the service's stored result for this messageId; Blooio and Twilio
      // were acknowledged already and do not retry.
      throw new PersonalSharedPreEgressError("network service unavailable", {
        cause: error,
      });
    }
    if (outcome.kind === "reply") {
      // Cloud resolves the trusted sender through the existing phone owner;
      // the canonical room records inbound, owns dispatch and records acceptance.
      const path = "/api/internal/eliza-app/personal-shared/messages";
      const body = JSON.stringify({
        platform: outcome.request.channel,
        project: "network",
        connectorAccountId: resolveConnectorAccountId(adapter.platform, config),
        phoneNumber: event.senderId,
        messageId: `${outcome.request.channel}:network:${event.messageId}`,
        message: event.text,
        networkHandled: { request: outcome.request, response: outcome.handled },
      });
      let delivered: Record<string, unknown> | undefined;
      let accepted = false;
      let unknown = false;
      let notAccepted = false;
      try {
        const signed = await svcSign(process.env.SERVICE_TURN_SECRET, {
          method: "POST",
          path,
          id: event.messageId,
          body,
        });
        const response = await fetch(`${cloudBaseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeader(),
            ...signed,
          },
          body,
          signal: AbortSignal.timeout(PERSONAL_SHARED_TURN_TIMEOUT_MS),
        });
        const result = (await response.json()) as {
          data?: { delivery?: Record<string, unknown> };
        };
        delivered = result.data?.delivery;
        accepted =
          response.status === 200 &&
          delivered?.ok === true &&
          Array.isArray(delivered.providerMessageIds) &&
          delivered.providerMessageIds.every(
            (value) => typeof value === "string" && value.trim(),
          ) &&
          new Set(delivered.providerMessageIds).size ===
            delivered.providerMessageIds.length &&
          (outcome.handled.replyIds.length === 0 ||
            delivered.providerMessageIds.length > 0) &&
          (delivered.history === true ||
            (!outcome.handled.accountEligible &&
              (outcome.handled.replyKind === "compliance" ||
                (outcome.handled.replyKind === "reply" &&
                  outcome.handled.reason === "onboarding_asked" &&
                  outcome.handled.memberId === null &&
                  outcome.handled.app !== null)) &&
              delivered.history === false));
        unknown = response.status === 202 || delivered?.error === "unknown";
        notAccepted = !accepted && !unknown && response.status < 500;
      } catch {
        unknown = true;
      }
      await networkService.turnReceipt({
        channel: outcome.request.channel,
        messageId: event.messageId,
        replyIds: outcome.handled.replyIds,
        outcome: accepted ? "accepted" : notAccepted ? "rejected" : "unknown",
        providerMessageIds: accepted
          ? (delivered?.providerMessageIds as string[])
          : [],
        historyRecorded: accepted && delivered?.history === true,
      });
      if (!accepted && !unknown && !notAccepted)
        throw new PersonalSharedPreEgressError(
          "Network handled conversation owner unavailable",
        );
      logger.info("Network service handled turn", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        reason: outcome.reason,
        replies: outcome.texts.length,
      });
      return;
    }
    if (outcome.kind === "open") networkTurn = outcome.turn;
  }
  if (isNetworkProject(project) && !networkTurn) {
    // The Network without a service-owned turn (legacy, or a turn the service
    // ignored): carrier keywords (STOP/HELP/START) and the consent ledger run
    // before any identity, account, or agent work, so an ignored STOP is
    // still recorded and confirmed.
    let compliance: NetworkInboundCompliance;
    try {
      compliance = await handleNetworkInboundCompliance(
        networkConsentLedger(deps),
        project,
        event,
      );
    } catch (error) {
      // error-policy:J2 a ledger outage fails the turn before egress instead
      // of guessing consent. Blooio and Twilio were acknowledged already and
      // do not retry.
      throw new PersonalSharedPreEgressError(
        "network consent ledger unavailable",
        { cause: error },
      );
    }
    if (compliance.kind === "reply") {
      await sendDirectReply(
        adapter,
        config,
        event,
        deps,
        project,
        compliance.text,
        deliveryHooks,
      );
      logger.info("Network keyword handled", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        action: compliance.action,
      });
      return;
    }
    if (compliance.kind === "suppress") {
      logger.info("Network message suppressed by consent", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        reason: compliance.reason,
      });
      return;
    }
  }

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
    await sendReplyWithRequiredReceipt(
      adapter,
      config,
      event,
      linkAttempt.reply,
      deliveryHooks,
    );
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
        networkTurn,
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
    } catch (error) {
      // error-policy:J4 only a typed pre-egress failure on a private Telegram
      // turn degrades to the explicit safe reply below.
      if (
        adapter.platform === "telegram" &&
        event.chatType === "private" &&
        !event.membershipChange &&
        error instanceof PersonalSharedPreEgressError
      ) {
        logger.warn(
          "Personal Shared Telegram turn failed; delivering safe fallback",
          {
            project,
            platform: adapter.platform,
            messageId: event.messageId,
            traceId: trace.traceId,
            status: error.failure?.status ?? null,
            failureStage: error.failure?.stage ?? null,
            failureName: error.failure?.name ?? null,
            failureCauseName: error.failure?.causeName ?? null,
            retryable: error.failure?.retryable ?? false,
          },
        );
        await sendReplyWithRequiredReceipt(
          adapter,
          config,
          event,
          personalSharedFailureReply(error.failure),
          deliveryHooks,
        );
        return;
      }
      throw error;
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
      // The agent did not run and nothing was sent. A direct chat gets the
      // failure notice, so the ledger records a real delivery. A group gets
      // no notice and keeps the earlier behavior.
      if (isDirectChat(event)) {
        await sendDirectReply(
          adapter,
          config,
          event,
          deps,
          project,
          PERSONAL_SHARED_FAILURE_REPLY,
          deliveryHooks,
        );
      }
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
    await sendReplyWithRequiredReceipt(
      adapter,
      config,
      event,
      responseText,
      deliveryHooks,
    );
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

/** A one-to-one chat with a real inbound message, not a membership change. */
function isDirectChat(event: ChatEvent): boolean {
  return (
    event.chatType !== "group" &&
    event.chatType !== "supergroup" &&
    !event.membershipChange
  );
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
  networkTurn?: NetworkOpenTurn,
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
  let voiceNote:
    | Awaited<ReturnType<NonNullable<PlatformAdapter["resolveVoiceNote"]>>>
    | undefined;
  try {
    voiceNote = event.voiceNote
      ? await adapter.resolveVoiceNote?.(config, event)
      : undefined;
  } catch (error) {
    // error-policy:J2 voice resolution failures gain pre-egress context while
    // preserving the connector error as their cause.
    throw new PersonalSharedPreEgressError(
      "connector failed to resolve the supplied voice note",
      { cause: error },
    );
  }
  if (event.voiceNote && !voiceNote) {
    throw new PersonalSharedPreEgressError(
      "connector cannot resolve the supplied voice note",
    );
  }
  // Media turns mirror voice: the cloud route may spend fetch + vision + the
  // model turn, so an inline re-POST can overlap a still-running route
  // execution. The Worker's per-message description claim makes the overlap
  // spend-safe (the second execution sees the live claim and keeps the raw
  // text), but that raw turn would only race the enriched one, so media turns
  // still end provider/transport failures as a pre-egress failure.
  // Blooio private and group events share the same guarded cloud vision path.
  // Media URLs are forwarded only while that path is explicitly enabled.
  const isMediaTurn =
    inboundMediaVisionEnabled() &&
    adapter.platform === "blooio" &&
    !!event.mediaUrls?.length;
  // Voice and media turns can spend most of the 120-second processing lease in
  // STT/vision + the model. Only a stale-auth retry is safe inline; provider/
  // transport failures end the turn as a pre-egress failure instead of
  // overlapping the lease. Blooio and Twilio do not retry after their ACK.
  const isLongTurn = Boolean(voiceNote) || isMediaTurn;
  const maxAttempts = isLongTurn ? 2 : PERSONAL_SHARED_ATTEMPTS;
  const postMessage = async (authHeader: Record<string, string>) => {
    const body = JSON.stringify(
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
                ...(event.senderName ? { displayName: event.senderName } : {}),
                role:
                  adapter.platform === "telegram"
                    ? (event.groupActorRole ?? "unknown")
                    : "possessor",
              },
              messageId: `${adapter.platform}:${project}:${event.messageId}`,
              message: event.text,
              invocation: groupInvocationForEvent(event),
              ...(adapter.platform === "telegram" && event.providerThreadId
                ? { providerThreadId: event.providerThreadId }
                : {}),
              ...(event.replyToMessageId
                ? { replyToMessageId: event.replyToMessageId }
                : {}),
              ...(isMediaTurn && event.mediaUrls?.length
                ? { mediaUrls: event.mediaUrls }
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
                // The Network service's open-turn context (takeover only).
                ...(networkTurn ? { networkTurn } : {}),
                // Only Blooio media URLs are provider-hosted and fetchable
                // by the cloud vision path; other platforms keep text-only.
                ...(isMediaTurn && event.mediaUrls?.length
                  ? { mediaUrls: event.mediaUrls }
                  : {}),
              },
    );
    const signed = networkTurn
      ? await svcSign(process.env.SERVICE_TURN_SECRET, {
          method: "POST",
          path: "/api/internal/eliza-app/personal-shared/messages",
          id: networkTurn.messageId,
          body,
        })
      : {};
    return fetch(
      `${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ELIZA_TRACE_ID_HEADER]: traceId,
          ...authHeader,
          ...signed,
        },
        body,
        signal: AbortSignal.timeout(
          voiceNote
            ? PERSONAL_SHARED_VOICE_TIMEOUT_MS
            : PERSONAL_SHARED_TURN_TIMEOUT_MS,
        ),
      },
    );
  };

  let authHeader: Record<string, string> = getAuthHeader();
  let attemptResult: ResponseAttemptsResult;
  try {
    attemptResult = await executeResponseAttempts({
      maxAttempts,
      honorExplicitRetryable: adapter.platform === "telegram",
      authRefreshAttemptsOutsideBudget: 1,
      replayPolicy: "idempotent",
      request: () => postMessage(authHeader),
      refreshAuth: async () => {
        authHeader = await reauth();
      },
      retryStatuses: !isLongTurn,
      retryTransport: !isLongTurn,
      retryDelayCapMs: PERSONAL_SHARED_RETRY_DELAY_CAP_MS,
      reportObservationError: (error, observation) => {
        logger.warn("Personal Shared Cloud attempt observation failed", {
          traceId,
          project,
          platform: adapter.platform,
          messageId: event.messageId,
          attempt: observation.attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      observe: (observation) => {
        const response = observation.response;
        const failure = response
          ? readPersonalSharedFailureMetadata(response)
          : null;
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
          cloudFailureStage: failure?.stage ?? null,
          cloudFailureName: failure?.name ?? null,
          cloudFailureCauseName: failure?.causeName ?? null,
          ...(observation.error
            ? {
                errorName: safeObservedErrorName(observation.error),
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
      "personal Shared chat transport failed",
      { cause: error },
    );
  }
  const { response } = attemptResult;
  if (!response.ok) {
    const failure = readPersonalSharedFailureMetadata(response);
    let hold: CutoverHoldSignal | null = null;
    try {
      // Reading the body both releases it and exposes an explicit cutover
      // hold, which the caller parks durably instead of dropping (#22934).
      hold = await readCutoverHold(response);
    } catch (error) {
      // error-policy:J6 an unreadable failure body is not a hold; the
      // classified pre-egress failure and the private DM fallback still run.
      logger.warn("Personal Shared failure body read failed", {
        traceId,
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        status: response.status,
        errorName: safeObservedErrorName(error),
      });
    }
    throw new PersonalSharedPreEgressError(
      `personal Shared chat failed (${response.status})`,
      { failure, hold },
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
  const data =
    body &&
    typeof body === "object" &&
    "data" in body &&
    body.data &&
    typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : null;
  const reply = data?.reply;
  if (typeof reply !== "string") {
    throw new PersonalSharedPreEgressError(
      "personal Shared chat returned no reply",
    );
  }
  const replyMediaUrls = parsePersonalSharedMediaUrls(
    data,
    adapter.platform === "telegram" &&
      event.chatType === "private" &&
      !event.membershipChange,
  );
  if (
    adapter.platform === "telegram" &&
    event.chatType === "private" &&
    !event.membershipChange &&
    reply.trim().length === 0 &&
    replyMediaUrls.length === 0
  ) {
    throw new PersonalSharedPreEgressError(
      "personal Shared private turn completed without a reply",
      { failure: personalSharedNoResponseFailure() },
    );
  }
  const replyText = reply
    .split("\n")
    .filter((line) => !replyMediaUrls.includes(line.trim()))
    .join("\n")
    .trim();
  // Empty is the agent's deliberate shouldRespond=no result. Membership
  // changes and stale turns intentionally take this path with no authority
  // token because there will be no provider egress to authorize.
  // A direct reply that is only media still has something to deliver. Telegram
  // appends media links only in private chats, so its channels stay excluded.
  const hasDeliverableMedia =
    replyMediaUrls.length > 0 &&
    isDirectChat(event) &&
    (adapter.platform !== "telegram" || event.chatType === "private");
  if (reply.length === 0 && !hasDeliverableMedia) {
    return {
      cloudMs,
      cloudAttempts: attemptResult.attempts,
      egressMs: 0,
      cloudServerTiming,
    };
  }
  // A STOP that landed while this Network turn was running wins: re-read the
  // ledger immediately before egress so no reply follows the confirmation.
  if (isNetworkProject(project) && !isGroup) {
    let optedOut: boolean;
    try {
      // An app-scoped START newer than a line-wide STOP reopens that app,
      // as the internal delivery fence already reads it.
      optedOut = await isNetworkAddressOptedOut(
        networkConsentLedger(deps),
        project,
        event.senderId,
        networkTurn?.app,
      );
    } catch (error) {
      throw new PersonalSharedPreEgressError(
        "network consent ledger unavailable",
        { cause: error },
      );
    }
    if (optedOut) {
      logger.info("Network reply suppressed: recipient opted out mid-turn", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
      });
      return {
        cloudMs,
        cloudAttempts: attemptResult.attempts,
        egressMs: 0,
        cloudServerTiming,
      };
    }
  }
  const groupDelivery = parseGroupDeliveryDirective(data?.groupDelivery);
  const egressStartedAt = Date.now();
  if (isGroup) {
    if (!groupDelivery) {
      throw new PersonalSharedPreEgressError(
        "personal Shared group reply returned no delivery directive",
      );
    }
    if (!sendReplyWithReceipt) {
      throw new PersonalSharedPreEgressError(
        "group connector cannot return a provider delivery receipt",
      );
    }
    if (groupDelivery.kind === "control") {
      await sendReplyWithReceipt(
        config,
        event,
        replyText,
        deliveryHooks,
        replyMediaUrls,
      );
      return {
        cloudMs,
        cloudAttempts: attemptResult.attempts,
        egressMs: Date.now() - egressStartedAt,
        cloudServerTiming,
      };
    }
    const deliveryLeaseToken = crypto.randomUUID();
    const sourceMessageId = `${adapter.platform}:${project}:${event.messageId}`;
    const authorizationBody = JSON.stringify({
      eventType: "delivery_authorization",
      platform: adapter.platform,
      project,
      connectorAccountId,
      chatId: event.chatId,
      sourceMessageId,
      leaseToken: deliveryLeaseToken,
      invocation: groupInvocationForEvent(event),
      authority: groupDelivery.authority,
    });
    const postAuthorization = (header: Record<string, string>) =>
      fetch(`${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ELIZA_TRACE_ID_HEADER]: traceId,
          ...header,
        },
        body: authorizationBody,
        signal: AbortSignal.timeout(10_000),
      });
    let authorizationResponse = await postAuthorization(authHeader);
    if (
      authorizationResponse.status === 401 ||
      authorizationResponse.status === 403
    ) {
      await authorizationResponse.body?.cancel();
      authHeader = await reauth();
      authorizationResponse = await postAuthorization(authHeader);
    }
    if (!authorizationResponse.ok) {
      await authorizationResponse.body?.cancel();
      throw new PersonalSharedPreEgressError(
        `group delivery authorization failed (${authorizationResponse.status})`,
      );
    }
    let authorizationResult: unknown;
    try {
      authorizationResult = await authorizationResponse.json();
    } catch (error) {
      // error-policy:J3 authorization is untrusted until the explicit boolean
      // contract parses; provider egress has not started.
      throw new PersonalSharedPreEgressError(
        "group delivery authorization returned invalid JSON",
        { cause: error },
      );
    }
    const authorizationData =
      authorizationResult !== null &&
      typeof authorizationResult === "object" &&
      "success" in authorizationResult &&
      authorizationResult.success === true &&
      "data" in authorizationResult &&
      authorizationResult.data !== null &&
      typeof authorizationResult.data === "object" &&
      (authorizationResult.data as Record<string, unknown>);
    const leaseExpiresAtMs =
      authorizationData !== false &&
      typeof authorizationData.expiresAt === "string"
        ? Date.parse(authorizationData.expiresAt)
        : Number.NaN;
    const authorizationObservedAt = Date.now();
    if (
      authorizationData !== false &&
      authorizationData.authorized === false &&
      authorizationData.reason === "source_already_attempted" &&
      (authorizationData.deliveryState === "committed" ||
        authorizationData.deliveryState === "uncertain")
    ) {
      logger.warn("Personal Shared delivery outcome remains uncertain", {
        project,
        platform: adapter.platform,
        messageId: event.messageId,
        sourceMessageId,
        deliveryState: authorizationData.deliveryState,
        operatorAction:
          "reconcile the durable provider attempt before retrying this source",
        traceId,
      });
    }
    if (
      authorizationData === false ||
      authorizationData.code !== "group_delivery_authorization" ||
      authorizationData.authorized !== true ||
      authorizationData.leaseToken !== deliveryLeaseToken ||
      !Number.isFinite(leaseExpiresAtMs) ||
      leaseExpiresAtMs <= authorizationObservedAt ||
      leaseExpiresAtMs >
        authorizationObservedAt + PERSONAL_SHARED_DELIVERY_LEASE_MS
    ) {
      return {
        cloudMs,
        cloudAttempts: attemptResult.attempts,
        egressMs: 0,
        cloudServerTiming,
      };
    }
    const commitBody = JSON.stringify({
      eventType: "delivery_commit",
      platform: adapter.platform,
      project,
      connectorAccountId,
      chatId: event.chatId,
      sourceMessageId,
      leaseToken: deliveryLeaseToken,
      authority: groupDelivery.authority,
    });
    const postCommit = (header: Record<string, string>) =>
      fetch(`${cloudBaseUrl}/api/internal/eliza-app/personal-shared/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ELIZA_TRACE_ID_HEADER]: traceId,
          ...header,
        },
        body: commitBody,
        signal: AbortSignal.timeout(10_000),
      });
    let commitResponse = await postCommit(authHeader);
    if (commitResponse.status === 401 || commitResponse.status === 403) {
      await commitResponse.body?.cancel();
      authHeader = await reauth();
      commitResponse = await postCommit(authHeader);
    }
    if (!commitResponse.ok) {
      await commitResponse.body?.cancel();
      throw new PersonalSharedPreEgressError(
        `group delivery commit failed (${commitResponse.status})`,
      );
    }
    let commitResult: unknown;
    try {
      commitResult = await commitResponse.json();
    } catch (error) {
      // error-policy:J3 no provider call begins unless the durable commit's
      // explicit boolean contract parses.
      throw new PersonalSharedPreEgressError(
        "group delivery commit returned invalid JSON",
        { cause: error },
      );
    }
    const committed =
      commitResult !== null &&
      typeof commitResult === "object" &&
      "success" in commitResult &&
      commitResult.success === true &&
      "data" in commitResult &&
      commitResult.data !== null &&
      typeof commitResult.data === "object" &&
      "code" in commitResult.data &&
      commitResult.data.code === "group_delivery_committed" &&
      "committed" in commitResult.data &&
      commitResult.data.committed === true;
    if (!committed) {
      return {
        cloudMs,
        cloudAttempts: attemptResult.attempts,
        egressMs: 0,
        cloudServerTiming,
      };
    }
    const receipt = await sendReplyWithReceipt(
      config,
      event,
      replyText,
      deliveryHooks,
      replyMediaUrls,
    );
    const receiptBody = JSON.stringify({
      eventType: "delivery_receipt",
      platform: adapter.platform,
      project,
      connectorAccountId,
      chatId: event.chatId,
      sourceMessageId,
      providerMessageIds: receipt.providerMessageIds,
      authority: groupDelivery.authority,
      leaseToken: deliveryLeaseToken,
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
      throw new PersonalSharedRecoverablePostEgressError(
        `group delivery receipt persistence failed (${receiptResponse.status})`,
      );
    }
    let receiptResult: unknown;
    try {
      receiptResult = await receiptResponse.json();
    } catch (error) {
      // error-policy:J3 provider egress is idempotent, so malformed receipt
      // persistence can reopen the webhook for an exact retry.
      throw new PersonalSharedRecoverablePostEgressError(
        "group delivery receipt persistence returned invalid JSON",
        { cause: error },
      );
    }
    const recorded =
      receiptResult !== null &&
      typeof receiptResult === "object" &&
      "success" in receiptResult &&
      receiptResult.success === true &&
      "data" in receiptResult &&
      receiptResult.data !== null &&
      typeof receiptResult.data === "object" &&
      "code" in receiptResult.data &&
      receiptResult.data.code === "group_delivery_receipt_recorded" &&
      "recorded" in receiptResult.data &&
      receiptResult.data.recorded === true;
    if (!recorded) {
      throw new PersonalSharedRecoverablePostEgressError(
        "group delivery receipt persistence rejected stale authority",
      );
    }
  } else {
    await sendDirectReply(
      adapter,
      config,
      event,
      deps,
      project,
      replyText,
      deliveryHooks,
      replyMediaUrls,
    );
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
      diagnostics = truncateWellFormed(
        toWellFormedUnicode(await response.text()),
        200,
      );
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
  await sendReplyWithRequiredReceipt(
    adapter,
    config,
    event,
    reply,
    deliveryHooks,
  );
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
