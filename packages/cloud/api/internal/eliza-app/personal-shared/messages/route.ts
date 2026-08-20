/** Runs a trusted messaging delivery through one rowless personal Shared turn. */

import { Hono } from "hono";
import { z } from "zod";
import { resolvePersonalDeliveryProjection } from "@/api-app/personal-delivery-projection";
import type { AgentSandbox } from "@/db/schemas/agent-sandboxes";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { resolveElizaTraceId } from "@/lib/observability/http-telemetry";
import { sha256Hex } from "@/lib/oidc/crypto";
import { findActivePersonalDedicatedTarget } from "@/lib/services/agent-tier-upgrade-target";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { runOnboardingChat } from "@/lib/services/eliza-app/onboarding-chat";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { preparePersonalDedicatedDelivery } from "@/lib/services/personal-dedicated-delivery";
import { coordinateSharedHistory } from "@/lib/services/shared-runtime/conversation-coordinator";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { prewarmPersonalSharedAgentTurnCaches } from "@/lib/services/shared-runtime/prewarm-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { resolveSharedCapabilityIntent } from "@/lib/services/shared-runtime/shared-capability-wall";
import { sharedRestMessageSend } from "@/lib/services/shared-runtime/shared-rest-adapter";
import { SharedRuntimeCacheWarmingError } from "@/lib/services/shared-runtime/shared-runtime-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";
import { consumePreverifiedPersonalSharedRequest } from "../preverified-auth";

// Telegram's hosted Bot API download ceiling is 20 MiB. This stricter product
// ceiling keeps the base64 JSON body (~10.7 MiB) and decoded copies bounded in
// a 128 MiB Worker isolate while covering ordinary conversational voice notes.
const MAX_TELEGRAM_VOICE_BYTES = 8 * 1024 * 1024;
const MAX_TELEGRAM_VOICE_BASE64_LENGTH =
  Math.ceil(MAX_TELEGRAM_VOICE_BYTES / 3) * 4;
const DEFAULT_WHISPER_MODEL = "Systran/faster-whisper-small";
const FAILURE_STAGE_HEADER = "X-Eliza-Failure-Stage";
const FAILURE_NAME_HEADER = "X-Eliza-Failure-Name";

type DeliveryStage =
  | "authentication"
  | "validation"
  | "worker_context"
  | "account_resolution"
  | "voice_transcription"
  | "account_claim"
  | "dedicated_runtime"
  | "shared_runtime";

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "ApiError",
  "Error",
  "HTTPException",
  "InsufficientCreditsError",
  "RangeError",
  "RateLimitError",
  "SharedRuntimeCacheWarmingError",
  "SharedTurnConflictError",
  "TimeoutError",
  "TypeError",
]);

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return SAFE_ERROR_NAMES.has(name) ? name : "OtherError";
}

function isGatewayNativeReminderTurn(message: string): boolean {
  const resolution = resolveSharedCapabilityIntent(message, {
    reminders: true,
  });
  return (
    resolution?.kind === "enabled-primary" &&
    resolution.primary.capability === "reminders"
  );
}

const telegramVoiceNoteSchema = z.object({
  bytesBase64: z.string().min(1).max(MAX_TELEGRAM_VOICE_BASE64_LENGTH),
  mimeType: z.literal("audio/ogg"),
  filename: z
    .string()
    .trim()
    .regex(/^telegram-[A-Za-z0-9:._-]+\.ogg$/),
  sizeBytes: z.number().int().positive().max(MAX_TELEGRAM_VOICE_BYTES),
  durationSeconds: z
    .number()
    .int()
    .min(0)
    .max(15 * 60),
});

const sharedMessageSchema = z.discriminatedUnion("platform", [
  z
    .object({
      platform: z.literal("telegram"),
      project: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
      chatId: z
        .string()
        .trim()
        .regex(/^-?\d{1,20}$/),
      telegramUserId: z
        .string()
        .trim()
        .regex(/^\d{1,20}$/),
      telegramUsername: z.string().trim().min(1).max(64).optional(),
      displayName: z.string().trim().min(1).max(128).optional(),
      messageId: z.string().trim().min(1).max(160),
      message: z.string().trim().min(1).max(4000).optional(),
      voiceNote: telegramVoiceNoteSchema.optional(),
    })
    .refine(
      (input) => input.message !== undefined || input.voiceNote !== undefined,
    ),
  z.object({
    platform: z.literal("discord"),
    discordUserId: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    discordUsername: z.string().trim().min(1).max(80),
    displayName: z.string().trim().min(1).max(128).optional(),
    avatarUrl: z.string().url().nullable().optional(),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
  z.object({
    platform: z.enum(["twilio", "blooio"]),
    project: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
]);

function decodeTelegramVoiceNote(
  input: z.infer<typeof telegramVoiceNoteSchema>,
): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.bytesBase64)) {
    throw new Error("Telegram voice note is not canonical base64");
  }
  const bytes = Buffer.from(input.bytesBase64, "base64");
  if (
    bytes.byteLength !== input.sizeBytes ||
    bytes.byteLength > MAX_TELEGRAM_VOICE_BYTES ||
    bytes.toString("base64") !== input.bytesBase64
  ) {
    throw new Error("Telegram voice note byte length is invalid");
  }
  if (bytes.subarray(0, 4).toString("ascii") !== "OggS") {
    throw new Error("Telegram voice note is not an Ogg stream");
  }
  return bytes;
}

async function transcribeTelegramVoiceNote(
  env: AppEnv["Bindings"],
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const whisperBaseUrl = env.WHISPER_STT_URL?.trim();
  if (!whisperBaseUrl) {
    throw new Error("Telegram voice transcription is not configured");
  }
  const audio = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(audio).set(bytes);
  const form = new FormData();
  form.append("file", new File([audio], filename, { type: "audio/ogg" }));
  form.append("model", env.WHISPER_STT_MODEL?.trim() || DEFAULT_WHISPER_MODEL);
  const response = await fetch(
    `${whisperBaseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Telegram voice transcription failed (${response.status})`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // error-policy:J3 the transcription provider response is untrusted input.
    throw new Error("Telegram voice transcription returned invalid JSON", {
      cause: error,
    });
  }
  const transcript =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).text === "string"
      ? ((payload as Record<string, unknown>).text as string).trim()
      : "";
  if (!transcript) {
    throw new Error("Telegram voice transcription returned no speech");
  }
  return transcript;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let stage: DeliveryStage = "authentication";
  try {
    const auth =
      consumePreverifiedPersonalSharedRequest(c.req.raw) ??
      (await requireInternalAuth(c));
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "webhook-gateway" &&
      auth.service !== "discord-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return jsonError(c, 403, "Forbidden", "access_denied");
    }

    stage = "validation";
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // error-policy:J3 malformed provider input is explicitly invalid.
      return jsonError(
        c,
        400,
        "Invalid messaging delivery",
        "validation_error",
      );
    }
    const parsed = sharedMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "Invalid messaging delivery",
        "validation_error",
      );
    }
    let telegramVoiceBytes: Uint8Array | undefined;
    if (parsed.data.platform === "telegram" && parsed.data.voiceNote) {
      try {
        telegramVoiceBytes = decodeTelegramVoiceNote(parsed.data.voiceNote);
      } catch {
        // error-policy:J3 decoded media bytes are untrusted transport input.
        return jsonError(
          c,
          400,
          "Invalid Telegram voice note",
          "validation_error",
        );
      }
    }

    stage = "worker_context";
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) {
      return c.json(
        {
          success: false,
          error: worker.error,
          code: worker.code,
          retryable: worker.retryable,
        },
        worker.status,
        { "Retry-After": "1" },
      );
    }

    stage = "account_resolution";
    const accountStartedAt = performance.now();
    let account: { userId: string; organizationId: string };
    let accountResolution = "phone-query";
    let dedicated:
      | Pick<AgentSandbox, "id" | "status" | "bridge_url" | "agent_config">
      | null
      | undefined;
    let isNewPersonalAccount = false;
    if (parsed.data.platform === "telegram") {
      const delivery = await resolvePersonalDeliveryProjection(
        c.env,
        {
          platform: "telegram",
          telegramId: parsed.data.telegramUserId,
          username: parsed.data.telegramUsername,
          displayName: parsed.data.displayName,
        },
        elizaAppUserService,
      );
      account = {
        userId: delivery.userId,
        organizationId: delivery.organizationId,
      };
      accountResolution = delivery.resolution;
      dedicated = delivery.dedicatedTarget;
      isNewPersonalAccount = delivery.isNew;
    } else if (parsed.data.platform === "discord") {
      const delivery = await resolvePersonalDeliveryProjection(
        c.env,
        {
          platform: "discord",
          discordId: parsed.data.discordUserId,
          username: parsed.data.discordUsername,
          globalName: parsed.data.displayName,
          avatarUrl: parsed.data.avatarUrl,
        },
        elizaAppUserService,
      );
      account = {
        userId: delivery.userId,
        organizationId: delivery.organizationId,
      };
      accountResolution = delivery.resolution;
      dedicated = delivery.dedicatedTarget;
      isNewPersonalAccount = delivery.isNew;
    } else {
      const phoneAccount = await elizaAppUserService.findOrCreateByPhone(
        parsed.data.phoneNumber,
      );
      account = {
        userId: phoneAccount.user.id,
        organizationId: phoneAccount.organization.id,
      };
      isNewPersonalAccount = phoneAccount.isNew;
    }
    const accountMs = performance.now() - accountStartedAt;
    const accountTiming = `account;dur=${accountMs.toFixed(1)};desc="${accountResolution}"`;
    c.header("Server-Timing", accountTiming);
    const agent = personalSharedAgent({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    const startPersonalPrewarm = () => {
      const startedAt = performance.now();
      const timing = prewarmPersonalSharedAgentTurnCaches(
        agent,
        worker.namespace,
        { warmConversation: isNewPersonalAccount },
      ).then(() => performance.now() - startedAt);
      worker.executionCtx.waitUntil(timing);
      return timing;
    };
    let personalPrewarm = dedicated ? null : startPersonalPrewarm();
    let deliveryMessage = parsed.data.message;
    if (
      parsed.data.platform === "telegram" &&
      parsed.data.voiceNote &&
      telegramVoiceBytes
    ) {
      stage = "voice_transcription";
      // Shared has no authenticated writer into the agent-owned canonical
      // `/api/media/<sha>.<ext>` store. Keep only the transcript in durable
      // conversation history; do not create a parallel R2 media namespace.
      const transcript = await transcribeTelegramVoiceNote(
        c.env,
        telegramVoiceBytes,
        parsed.data.voiceNote.filename,
      );
      deliveryMessage = parsed.data.message
        ? `${parsed.data.message}\n\n[Voice note transcript]\n${transcript}`
        : transcript;
      logger.info(
        "[personal-shared-messaging] Telegram voice note transcribed",
        {
          durationSeconds: parsed.data.voiceNote.durationSeconds,
          sizeBytes: parsed.data.voiceNote.sizeBytes,
          userId: account.userId,
        },
      );
    }
    if (!deliveryMessage) {
      return jsonError(
        c,
        400,
        "Messaging delivery has no content",
        "validation_error",
      );
    }
    if (
      parsed.data.platform === "telegram" &&
      /^\/connect(?:@[a-z0-9_]{5,32})?$/i.test(deliveryMessage)
    ) {
      stage = "account_claim";
      // A new command gets independent expiry while a webhook retry reaches
      // the same session. Reusing the sender's permanent session would make
      // refreshing one claim link revive every expired link for that sender.
      const claimSessionId = `platform:telegram-claim:${await sha256Hex(
        `${parsed.data.telegramUserId}\n${parsed.data.messageId}`,
      )}`;
      const claim = await runOnboardingChat({
        sessionId: claimSessionId,
        platform: "telegram",
        platformUserId: parsed.data.telegramUserId,
        platformDisplayName:
          parsed.data.displayName ??
          parsed.data.telegramUsername ??
          parsed.data.telegramUserId,
        authenticatedUser: {
          userId: account.userId,
          organizationId: account.organizationId,
          telegramId: parsed.data.telegramUserId,
        },
        trustedPlatformIdentity: true,
        statusOnly: true,
        idempotencyKey: `telegram-account-claim:${parsed.data.messageId}`,
      });
      const loginUrl = new URL(claim.loginUrl);
      loginUrl.searchParams.set("accountClaim", "telegram");
      return c.json({
        success: true,
        data: {
          identity: { id: agent.id, runtime: "shared" as const },
          account: {
            userId: account.userId,
            organizationId: account.organizationId,
          },
          reply: `Sign in to connect this Telegram chat to your Eliza account: ${loginUrl.toString()}`,
        },
      });
    }
    if (dedicated === undefined) {
      dedicated = await findActivePersonalDedicatedTarget(
        account.organizationId,
        agent.id,
      );
    }
    // Connector-native reminders stay on the server-owned Personal Shared
    // scheduler even after a Dedicated cutover. Dedicated containers receive
    // the conversational turn through the bridge, but do not own the trusted
    // Telegram/Discord/Blooio delivery credential needed to persist and fire a
    // reminder back into this verified DM.
    const gatewayNativeReminderTurn =
      isGatewayNativeReminderTurn(deliveryMessage);
    if (dedicated && gatewayNativeReminderTurn && !personalPrewarm) {
      personalPrewarm = startPersonalPrewarm();
    }
    if (dedicated && !gatewayNativeReminderTurn) {
      stage = "dedicated_runtime";
      const dedicatedStartedAt = performance.now();
      const preparation = await preparePersonalDedicatedDelivery(
        dedicated,
        {
          organizationId: account.organizationId,
          userId: account.userId,
        },
        c.env,
        worker.executionCtx,
      );
      if (preparation.state === "blocked") {
        return c.json(
          {
            success: false,
            code: preparation.code,
            error: preparation.error,
            retryable: false,
            currentBalance: preparation.currentBalance,
          },
          402,
        );
      }
      if (preparation.state === "starting") {
        return c.json(
          {
            success: false,
            code: "dedicated_starting",
            error: "Dedicated Eliza is waking up. Retry this turn shortly.",
            retryable: true,
            data: {
              action: preparation.action,
              activeAgentId: dedicated.id,
              alreadyInProgress: !preparation.created,
              jobId: preparation.jobId,
            },
          },
          503,
          { "Retry-After": String(preparation.retryAfterSeconds) },
        );
      }
      if (preparation.state === "unavailable") {
        return c.json(
          {
            success: false,
            code: preparation.code,
            error: preparation.error,
            retryable: preparation.retryable,
          },
          preparation.status,
          preparation.retryAfterSeconds
            ? { "Retry-After": String(preparation.retryAfterSeconds) }
            : undefined,
        );
      }
      const bridgeRequest = {
        jsonrpc: "2.0" as const,
        id: parsed.data.messageId,
        method: "message.send",
        params: {
          text: deliveryMessage,
          roomId: agent.id,
          conversationId: agent.id,
          canonicalBridgeBase: dedicated.bridge_url,
          userId: account.userId,
          clientMessageId: parsed.data.messageId,
          platformName: parsed.data.platform,
          source: parsed.data.platform,
          ...(parsed.data.platform === "telegram" ||
          parsed.data.platform === "discord"
            ? {
                senderName:
                  parsed.data.displayName ??
                  (parsed.data.platform === "telegram"
                    ? parsed.data.telegramUsername
                    : parsed.data.discordUsername),
              }
            : {}),
        },
      };
      let response = await elizaSandboxService.bridge(
        dedicated.id,
        account.organizationId,
        bridgeRequest,
      );
      if (response.error?.message === "Bridge returned HTTP 404") {
        const history = await coordinateSharedHistory(agent.id, agent.id, {
          namespace: worker.namespace,
        });
        const importableHistory = history.filter(
          (
            message,
          ): message is typeof message & {
            role: "user" | "assistant";
          } => message.role === "user" || message.role === "assistant",
        );
        const importMessages = importableHistory.flatMap((message) =>
          message.id
            ? [
                {
                  sourceId: message.id,
                  role: message.role,
                  text: message.content,
                  ...(typeof message.createdAt === "number"
                    ? { timestamp: message.createdAt }
                    : {}),
                },
              ]
            : [],
        );
        let receipt =
          importMessages.length === importableHistory.length
            ? await elizaSandboxService.importCanonicalConversation(
                dedicated.id,
                account.organizationId,
                agent.id,
                importMessages,
              )
            : null;
        if (!receipt && importMessages.length > 0) {
          receipt = await elizaSandboxService.importCanonicalConversation(
            dedicated.id,
            account.organizationId,
            agent.id,
            [],
          );
        }
        if (receipt) {
          response = await elizaSandboxService.bridge(
            dedicated.id,
            account.organizationId,
            bridgeRequest,
          );
        }
      }
      if (response.error) {
        return jsonError(
          c,
          503,
          "Dedicated Eliza is temporarily unavailable.",
          "service_unavailable",
        );
      }
      const result = response.result as { text?: unknown } | undefined;
      if (typeof result?.text !== "string") {
        return jsonError(
          c,
          503,
          "Dedicated Eliza returned an invalid reply.",
          "service_unavailable",
        );
      }
      c.header(
        "Server-Timing",
        `${accountTiming}, dedicated;dur=${(
          performance.now() - dedicatedStartedAt
        ).toFixed(1)}`,
      );
      return c.json({
        success: true,
        data: {
          identity: {
            id: agent.id,
            runtime: "dedicated" as const,
            activeAgentId: dedicated.id,
          },
          account: {
            userId: account.userId,
            organizationId: account.organizationId,
          },
          reply: result.text,
        },
      });
    }
    stage = "shared_runtime";
    if (!personalPrewarm) {
      throw new Error("Shared turn reached inference with a Dedicated target");
    }
    const prewarmMs = await personalPrewarm;
    const sharedStartedAt = performance.now();
    const trustedDelivery =
      parsed.data.platform === "telegram"
        ? {
            platform: "telegram" as const,
            project: parsed.data.project,
            chatId: parsed.data.chatId,
          }
        : parsed.data.platform === "blooio"
          ? {
              platform: "blooio" as const,
              project: parsed.data.project,
              phoneNumber: parsed.data.phoneNumber,
            }
          : parsed.data.platform === "discord"
            ? {
                platform: "discord" as const,
                discordUserId: parsed.data.discordUserId,
              }
            : undefined;
    const result = await sharedRestMessageSend(
      agent,
      agent.id,
      deliveryMessage,
      agent.agent_name ?? "Eliza",
      worker.executionCtx,
      worker.namespace,
      parsed.data.messageId,
      "platform",
      trustedDelivery,
    );
    c.header(
      "Server-Timing",
      `${accountTiming}, prewarm;dur=${prewarmMs.toFixed(1)}, shared;dur=${(
        performance.now() - sharedStartedAt
      ).toFixed(1)}`,
    );

    return c.json({
      success: true,
      data: {
        identity: { id: agent.id, runtime: "shared" as const },
        account: {
          userId: account.userId,
          organizationId: account.organizationId,
        },
        reply: result.text,
      },
    });
  } catch (error) {
    // error-policy:J1 the internal HTTP boundary emits one structured failure.
    const errorName = safeErrorName(error);
    const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
    logger.error("[personal-shared-messaging] delivery failed", {
      traceId,
      stage,
      errorName,
    });
    // This route is internal-authenticated. Safe classification headers let
    // the connector correlate a retry without exposing exception messages or
    // provider/SQL payloads in its logs.
    c.header(FAILURE_STAGE_HEADER, stage);
    c.header(FAILURE_NAME_HEADER, errorName);
    if (error instanceof SharedRuntimeCacheWarmingError) {
      return c.json(
        {
          success: false,
          error: "Shared Eliza is warming. Retry this turn shortly.",
          code: "service_unavailable",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
