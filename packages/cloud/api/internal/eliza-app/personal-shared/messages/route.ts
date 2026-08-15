/** Runs a trusted messaging delivery through one rowless personal Shared turn. */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { sha256Hex } from "@/lib/oidc/crypto";
import { findActivePersonalDedicatedTarget } from "@/lib/services/agent-tier-upgrade-target";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { runOnboardingChat } from "@/lib/services/eliza-app/onboarding-chat";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { preparePersonalDedicatedDelivery } from "@/lib/services/personal-dedicated-delivery";
import { coordinateSharedHistory } from "@/lib/services/shared-runtime/conversation-coordinator";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { sharedRestMessageSend } from "@/lib/services/shared-runtime/shared-rest-adapter";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

// Telegram's hosted Bot API download ceiling is 20 MiB. This stricter product
// ceiling keeps the base64 JSON body (~10.7 MiB) and decoded copies bounded in
// a 128 MiB Worker isolate while covering ordinary conversational voice notes.
const MAX_TELEGRAM_VOICE_BYTES = 8 * 1024 * 1024;
const MAX_TELEGRAM_VOICE_BASE64_LENGTH =
  Math.ceil(MAX_TELEGRAM_VOICE_BYTES / 3) * 4;
const DEFAULT_WHISPER_MODEL = "Systran/faster-whisper-small";

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
    discordUserId: z.string().trim().min(1).max(32),
    discordUsername: z.string().trim().min(1).max(80),
    displayName: z.string().trim().min(1).max(128).optional(),
    avatarUrl: z.string().url().nullable().optional(),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
  z.object({
    platform: z.enum(["twilio", "blooio"]),
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
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "webhook-gateway" &&
      auth.service !== "discord-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return jsonError(c, 403, "Forbidden", "access_denied");
    }

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

    const account =
      parsed.data.platform === "telegram"
        ? await elizaAppUserService.findOrCreateByTelegram({
            telegramId: parsed.data.telegramUserId,
            username: parsed.data.telegramUsername,
            displayName: parsed.data.displayName,
          })
        : parsed.data.platform === "discord"
          ? await elizaAppUserService.findOrCreateByDiscordId(
              parsed.data.discordUserId,
              {
                username: parsed.data.discordUsername,
                globalName: parsed.data.displayName,
                avatarUrl: parsed.data.avatarUrl,
              },
            )
          : await elizaAppUserService.findOrCreateByPhone(
              parsed.data.phoneNumber,
            );
    const agent = personalSharedAgent({
      userId: account.user.id,
      organizationId: account.organization.id,
    });
    let deliveryMessage = parsed.data.message;
    if (
      parsed.data.platform === "telegram" &&
      parsed.data.voiceNote &&
      telegramVoiceBytes
    ) {
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
          userId: account.user.id,
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
          userId: account.user.id,
          organizationId: account.organization.id,
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
            userId: account.user.id,
            organizationId: account.organization.id,
          },
          reply: `Sign in to connect this Telegram chat to your Eliza account: ${loginUrl.toString()}`,
        },
      });
    }
    const dedicated = await findActivePersonalDedicatedTarget(
      account.organization.id,
      agent.id,
    );
    if (dedicated) {
      const preparation = await preparePersonalDedicatedDelivery(
        dedicated,
        {
          organizationId: account.organization.id,
          userId: account.user.id,
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
          userId: account.user.id,
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
        account.organization.id,
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
                account.organization.id,
                agent.id,
                importMessages,
              )
            : null;
        if (!receipt && importMessages.length > 0) {
          receipt = await elizaSandboxService.importCanonicalConversation(
            dedicated.id,
            account.organization.id,
            agent.id,
            [],
          );
        }
        if (receipt) {
          response = await elizaSandboxService.bridge(
            dedicated.id,
            account.organization.id,
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
      return c.json({
        success: true,
        data: {
          identity: {
            id: agent.id,
            runtime: "dedicated" as const,
            activeAgentId: dedicated.id,
          },
          account: {
            userId: account.user.id,
            organizationId: account.organization.id,
          },
          reply: result.text,
        },
      });
    }
    const result = await sharedRestMessageSend(
      agent,
      agent.id,
      deliveryMessage,
      agent.agent_name ?? "Eliza",
      worker.executionCtx,
      worker.namespace,
      parsed.data.messageId,
      "platform",
    );

    return c.json({
      success: true,
      data: {
        identity: { id: agent.id, runtime: "shared" as const },
        account: {
          userId: account.user.id,
          organizationId: account.organization.id,
        },
        reply: result.text,
      },
    });
  } catch (error) {
    // error-policy:J1 the internal HTTP boundary emits one structured failure.
    return failureResponse(c, error);
  }
});

export default app;
