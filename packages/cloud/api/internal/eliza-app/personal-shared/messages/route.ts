/** Runs a trusted messaging delivery through one rowless personal Shared turn. */

import { ChannelType } from "@elizaos/core/edge";
import { Hono } from "hono";
import { z } from "zod";
import {
  PersonalDeliveryAccountResolutionError,
  resolvePersonalDeliveryProjection,
} from "@/api-app/personal-delivery-projection";
import { personalSharedGroupsRepository } from "@/db/repositories/personal-shared-groups";
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
import {
  sharedRestMessageSend,
  sharedTurnServerTiming,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
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
const GROUP_CLAIM_TTL_MS = 10 * 60_000;
const GROUP_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH = 240;

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
  "PersonalDeliveryAccountResolutionError",
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

function isGroupDeliveryPendingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code ===
      "PERSONAL_SHARED_GROUP_DELIVERY_PENDING"
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

const projectSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i);
const connectorAccountIdSchema = z.string().trim().min(3).max(160);
const groupActorSchema = z.object({
  platformUserId: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(128).optional(),
  role: z.enum(["creator", "administrator", "member", "unknown", "possessor"]),
});
const groupDeliveryAuthoritySchema = z.object({
  bindingId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  personalAgentId: z.string().trim().min(1).max(160),
  version: z.number().int().positive(),
});
const groupFields = {
  project: projectSchema,
  connectorAccountId: connectorAccountIdSchema,
  chatId: z.string().trim().min(1).max(160),
  actor: groupActorSchema,
  messageId: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(4000),
  invocation: z.enum(["mention", "command", "reply", "ambient"]),
  replyToMessageId: z.string().trim().min(1).max(160).optional(),
};

const sharedMessageSchema = z.union([
  z.object({
    eventType: z.literal("membership"),
    platform: z.literal("telegram"),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    messageId: z.string().trim().min(1).max(160),
    membershipChange: z.enum(["joined", "removed"]),
  }),
  z.object({
    eventType: z.literal("delivery_authorization"),
    platform: z.enum(["telegram", "blooio"]),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    sourceMessageId: z
      .string()
      .trim()
      .min(1)
      .max(GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH),
    leaseToken: z.string().uuid(),
    invocation: z.enum(["mention", "command", "reply", "ambient"]),
    authority: groupDeliveryAuthoritySchema,
  }),
  z.object({
    eventType: z.literal("delivery_commit"),
    platform: z.enum(["telegram", "blooio"]),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    sourceMessageId: z
      .string()
      .trim()
      .min(1)
      .max(GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH),
    leaseToken: z.string().uuid(),
    authority: groupDeliveryAuthoritySchema,
  }),
  z.object({
    eventType: z.literal("delivery_receipt"),
    platform: z.enum(["telegram", "blooio"]),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    sourceMessageId: z
      .string()
      .trim()
      .min(1)
      .max(GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH),
    providerMessageIds: z
      .array(z.string().trim().min(1).max(160))
      .min(1)
      .max(8),
    leaseToken: z.string().uuid(),
    authority: groupDeliveryAuthoritySchema,
  }),
  z
    .object({
      platform: z.literal("telegram"),
      project: projectSchema,
      connectorAccountId: connectorAccountIdSchema,
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
    platform: z.literal("telegram"),
    chatType: z.enum(["group", "supergroup"]),
    ...groupFields,
  }),
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
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
  z.object({
    platform: z.literal("blooio"),
    chatType: z.literal("group"),
    ...groupFields,
  }),
]);

type SharedMessage = z.infer<typeof sharedMessageSchema>;
type GroupMessage = Extract<
  SharedMessage,
  { chatType: "group" | "supergroup" }
>;

interface GroupDeliveryAuthority {
  bindingId: string;
  ownerUserId: string;
  personalAgentId: string;
  version: number;
}

const GROUP_CONTROL_DELIVERY = { kind: "control" as const };

function groupBindingDelivery(binding: {
  id: string;
  owner_user_id: string;
  personal_agent_id: string;
  authority_version: number;
}): { kind: "binding"; authority: GroupDeliveryAuthority } {
  return {
    kind: "binding",
    authority: {
      bindingId: binding.id,
      ownerUserId: binding.owner_user_id,
      personalAgentId: binding.personal_agent_id,
      version: binding.authority_version,
    },
  };
}

function isGroupMessage(message: SharedMessage): message is GroupMessage {
  return "chatType" in message;
}

function groupClaimCommand(message: string): string | null {
  const match = message.match(
    /^(?:\/eliza_link(?:@[a-z0-9_]{5,32})?|eliza\s+link)\s+([2-9A-HJ-NP-Z]{8})$/i,
  );
  return match?.[1]?.toUpperCase() ?? null;
}

function groupPolicyCommand(
  message: string,
): "mention_only" | "ambient" | null {
  const match = message.match(
    /^(?:\/eliza_ambient(?:@[a-z0-9_]{5,32})?|eliza\s+ambient)\s+(on|off)$/i,
  );
  if (!match) return null;
  return match[1].toLowerCase() === "on" ? "ambient" : "mention_only";
}

function isGroupLeaveCommand(message: string): boolean {
  return /^(?:\/eliza_leave(?:@[a-z0-9_]{5,32})?|eliza\s+leave)$/i.test(
    message,
  );
}

function isGroupClaimRequest(message: string): boolean {
  return /^(?:\/group(?:@[a-z0-9_]{5,32})?|eliza\s+group)$/i.test(message);
}

function createGroupClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(
    bytes,
    (byte) => GROUP_CODE_ALPHABET[byte % GROUP_CODE_ALPHABET.length],
  ).join("");
}

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
    if ("eventType" in parsed.data) {
      if (parsed.data.eventType === "membership") {
        const binding =
          await personalSharedGroupsRepository.applyMembershipChange({
            platform: "telegram",
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            providerChatId: parsed.data.chatId,
            membershipChange: parsed.data.membershipChange,
          });
        return c.json({
          success: true,
          data: {
            code: binding
              ? `group_membership_${parsed.data.membershipChange}`
              : "group_membership_unchanged",
            reply: "",
          },
        });
      }
      if (parsed.data.eventType === "delivery_authorization") {
        const lease = await personalSharedGroupsRepository.authorizeDelivery({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
          sourceMessageId: parsed.data.sourceMessageId,
          leaseToken: parsed.data.leaseToken,
          invocation: parsed.data.invocation,
          authority: parsed.data.authority,
        });
        return c.json({
          success: true,
          data: { code: "group_delivery_authorization", ...lease },
        });
      }
      if (parsed.data.eventType === "delivery_commit") {
        const committed = await personalSharedGroupsRepository.commitDelivery({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
          sourceMessageId: parsed.data.sourceMessageId,
          authority: parsed.data.authority,
          leaseToken: parsed.data.leaseToken,
        });
        return c.json({
          success: true,
          data: { code: "group_delivery_committed", committed },
        });
      }
      const receipt =
        await personalSharedGroupsRepository.recordDeliveryReceipts({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
          sourceMessageId: parsed.data.sourceMessageId,
          providerMessageIds: parsed.data.providerMessageIds,
          authority: parsed.data.authority,
          leaseToken: parsed.data.leaseToken,
        });
      return c.json({
        success: true,
        data: { code: "group_delivery_receipt_recorded", ...receipt },
      });
    }
    let telegramVoiceBytes: Uint8Array | undefined;
    if (
      parsed.data.platform === "telegram" &&
      !isGroupMessage(parsed.data) &&
      parsed.data.voiceNote
    ) {
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
    let groupConversationId: string | undefined;
    let groupActorLabel: string | undefined;
    let groupPersonalAgentId: string | undefined;
    let groupDeliveryAuthority:
      | {
          bindingId: string;
          ownerUserId: string;
          personalAgentId: string;
          version: number;
        }
      | undefined;
    let dedicated:
      | Pick<AgentSandbox, "id" | "status" | "bridge_url" | "agent_config">
      | null
      | undefined;
    let isNewPersonalAccount = false;
    if (isGroupMessage(parsed.data)) {
      const claimCode = groupClaimCommand(parsed.data.message);
      if (claimCode) {
        if (
          parsed.data.platform === "telegram" &&
          parsed.data.actor.role !== "creator" &&
          parsed.data.actor.role !== "administrator"
        ) {
          return c.json({
            success: true,
            data: {
              code: "group_admin_required",
              reply:
                "Only a Telegram group creator or administrator can link Eliza. Make Eliza an admin, then have the same owner retry the link command.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        const claimed =
          await personalSharedGroupsRepository.consumeClaimAndBind({
            codeHash: await sha256Hex(claimCode),
            platform: parsed.data.platform,
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            providerChatId: parsed.data.chatId,
            actorPlatformUserId: parsed.data.actor.platformUserId,
          });
        if (claimed.status !== "bound") {
          return c.json({
            success: true,
            data: {
              code: `group_claim_${claimed.status}`,
              reply:
                claimed.status === "expired"
                  ? "That group link expired. DM Eliza `/group` for a fresh code, then paste the new link command here."
                  : claimed.status === "already_used"
                    ? "That group link was already used. DM Eliza `/group` for a new one if you are reconnecting."
                    : claimed.status === "already_bound"
                      ? "This group is already linked to another Eliza owner. That owner must disconnect it before a different owner can link it."
                      : "That group link is not valid for this account or sender. DM Eliza `/group` yourself and paste the exact command here.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_bound",
            identity: {
              id: claimed.binding.personal_agent_id,
              runtime: "shared" as const,
            },
            account: {
              userId: claimed.binding.owner_user_id,
              organizationId: claimed.binding.organization_id,
            },
            reply:
              "Eliza is linked to this group. I respond to explicit mentions, commands, and replies by default. The owner can say `Eliza ambient on`, `Eliza ambient off`, or `Eliza leave`.",
            groupDelivery: groupBindingDelivery(claimed.binding),
          },
        });
      }

      const binding = await personalSharedGroupsRepository.resolveBinding({
        platform: parsed.data.platform,
        project: parsed.data.project,
        connectorAccountId: parsed.data.connectorAccountId,
        providerChatId: parsed.data.chatId,
      });
      if (binding?.state !== "active") {
        return c.json({
          success: true,
          data: {
            code: binding ? "group_binding_suspended" : "group_not_bound",
            reply:
              parsed.data.invocation === "ambient"
                ? ""
                : binding
                  ? "This group link is inactive. The owner can DM Eliza `/group` to reconnect it."
                  : "This group is not linked yet. DM your Eliza `/group`, then paste the one-time link command here.",
            groupDelivery: GROUP_CONTROL_DELIVERY,
          },
        });
      }

      const requestedPolicy = groupPolicyCommand(parsed.data.message);
      const ownerControl =
        requestedPolicy !== null || isGroupLeaveCommand(parsed.data.message);
      if (
        ownerControl &&
        parsed.data.actor.platformUserId !== binding.created_by_platform_user_id
      ) {
        return c.json({
          success: true,
          data: {
            code: "group_owner_required",
            reply:
              "Only the owner who linked Eliza can change this group's response policy.",
            groupDelivery: groupBindingDelivery(binding),
          },
        });
      }

      if (requestedPolicy) {
        const updated = await personalSharedGroupsRepository.setResponsePolicy({
          bindingId: binding.id,
          ownerUserId: binding.owner_user_id,
          policy: requestedPolicy,
        });
        if (!updated) {
          return c.json({
            success: true,
            data: {
              code: "group_binding_changed",
              reply:
                "This group link changed before the policy update. Reconnect it and try again.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_policy_updated",
            reply:
              requestedPolicy === "ambient"
                ? "Ambient replies are on. I may respond without a mention when I have something useful to add. Say `Eliza ambient off` to return to mention-only."
                : "Mention-only is on. I will answer explicit mentions, commands, and replies to me.",
            groupDelivery: groupBindingDelivery(updated),
          },
        });
      }
      if (isGroupLeaveCommand(parsed.data.message)) {
        const revoked = await personalSharedGroupsRepository.revokeBinding({
          bindingId: binding.id,
          ownerUserId: binding.owner_user_id,
        });
        if (!revoked) {
          return c.json({
            success: true,
            data: {
              code: "group_binding_changed",
              reply: "This group link changed before it could be disconnected.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_binding_revoked",
            reply:
              "This group is disconnected from your Eliza. Remove the bot/account here, or DM Eliza `/group` later to reconnect.",
            groupDelivery: GROUP_CONTROL_DELIVERY,
          },
        });
      }
      const verifiedInvocation =
        parsed.data.platform === "blooio" &&
        parsed.data.invocation === "reply" &&
        (!parsed.data.replyToMessageId ||
          !(await personalSharedGroupsRepository.hasDeliveryReceipt({
            bindingId: binding.id,
            providerMessageId: parsed.data.replyToMessageId,
          })))
          ? "ambient"
          : parsed.data.invocation;
      if (
        binding.response_policy === "mention_only" &&
        verifiedInvocation === "ambient"
      ) {
        return c.json({
          success: true,
          data: { code: "group_silent", reply: "" },
        });
      }

      account = {
        userId: binding.owner_user_id,
        organizationId: binding.organization_id,
      };
      accountResolution = "group-binding";
      groupConversationId = binding.conversation_id;
      groupPersonalAgentId = binding.personal_agent_id;
      groupDeliveryAuthority = groupBindingDelivery(binding).authority;
      const actorDigest = (
        await sha256Hex(
          `${parsed.data.platform}\n${parsed.data.actor.platformUserId}`,
        )
      ).slice(0, 8);
      groupActorLabel = `${parsed.data.actor.displayName ?? "Participant"} [participant ${actorDigest}]`;
    } else if (parsed.data.platform === "telegram") {
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
      const delivery = await resolvePersonalDeliveryProjection(
        c.env,
        {
          platform: "phone",
          phoneNumber: parsed.data.phoneNumber,
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
    }
    const agent = personalSharedAgent({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    if (groupConversationId && !groupConversationId.startsWith("group:")) {
      throw new Error("Invalid Personal Shared group conversation authority");
    }
    if (groupConversationId && groupPersonalAgentId !== agent.id) {
      throw new Error(
        "Personal Shared group binding does not match its canonical owner",
      );
    }

    if (
      !isGroupMessage(parsed.data) &&
      (parsed.data.platform === "telegram" ||
        parsed.data.platform === "blooio") &&
      isGroupClaimRequest(parsed.data.message ?? "")
    ) {
      const code = createGroupClaimCode();
      await personalSharedGroupsRepository.issueClaim({
        codeHash: await sha256Hex(code),
        organizationId: account.organizationId,
        ownerUserId: account.userId,
        personalAgentId: agent.id,
        platform: parsed.data.platform,
        project: parsed.data.project,
        connectorAccountId: parsed.data.connectorAccountId,
        issuedToPlatformUserId:
          parsed.data.platform === "telegram"
            ? parsed.data.telegramUserId
            : parsed.data.phoneNumber,
        expiresAt: new Date(Date.now() + GROUP_CLAIM_TTL_MS),
      });
      const linkCommand =
        parsed.data.platform === "telegram"
          ? `/eliza_link ${code}`
          : `Eliza link ${code}`;
      return c.json({
        success: true,
        data: {
          code: "group_claim_issued",
          identity: { id: agent.id, runtime: "shared" as const },
          account: {
            userId: account.userId,
            organizationId: account.organizationId,
          },
          reply: `Add Eliza to the group, then send this there within 10 minutes:\n\n${linkCommand}\n\nUse the same ${parsed.data.platform === "telegram" ? "Telegram account" : "iMessage identity"} that requested this code.`,
        },
      });
    }
    if (dedicated === undefined) {
      dedicated = await findActivePersonalDedicatedTarget(
        account.organizationId,
        agent.id,
      );
    }
    const accountMs = performance.now() - accountStartedAt;
    const accountTiming = `account;dur=${accountMs.toFixed(1)};desc="${accountResolution}"`;
    c.header("Server-Timing", accountTiming);
    const personalPrewarm = dedicated
      ? null
      : (() => {
          const startedAt = performance.now();
          const timing = prewarmPersonalSharedAgentTurnCaches(
            agent,
            worker.namespace,
            {
              warmConversation:
                isNewPersonalAccount || Boolean(groupConversationId),
              ...(groupConversationId
                ? { conversationId: groupConversationId }
                : {}),
            },
          ).then(() => performance.now() - startedAt);
          worker.executionCtx.waitUntil(timing);
          return timing;
        })();
    let deliveryMessage = parsed.data.message;
    if (
      parsed.data.platform === "telegram" &&
      !isGroupMessage(parsed.data) &&
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
    if (deliveryMessage && groupActorLabel) {
      deliveryMessage = `${groupActorLabel}: ${deliveryMessage}`;
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
      !isGroupMessage(parsed.data) &&
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
    if (dedicated) {
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
          roomId: groupConversationId ?? agent.id,
          conversationId: groupConversationId ?? agent.id,
          canonicalBridgeBase: dedicated.bridge_url,
          userId: account.userId,
          clientMessageId: parsed.data.messageId,
          platformName: parsed.data.platform,
          source: parsed.data.platform,
          ...(isGroupMessage(parsed.data)
            ? { senderName: groupActorLabel }
            : parsed.data.platform === "telegram" ||
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
        const conversationId = groupConversationId ?? agent.id;
        const history = await coordinateSharedHistory(
          agent.id,
          conversationId,
          {
            namespace: worker.namespace,
          },
        );
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
                conversationId,
                importMessages,
              )
            : null;
        if (!receipt && importMessages.length > 0) {
          receipt = await elizaSandboxService.importCanonicalConversation(
            dedicated.id,
            account.organizationId,
            conversationId,
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
          ...(groupDeliveryAuthority
            ? {
                groupDelivery: {
                  kind: "binding" as const,
                  authority: groupDeliveryAuthority,
                },
              }
            : {}),
        },
      });
    }
    stage = "shared_runtime";
    if (!personalPrewarm) {
      throw new Error("Shared turn reached inference with a Dedicated target");
    }
    const prewarmMs = await personalPrewarm;
    const sharedStartedAt = performance.now();
    const trustedDelivery = isGroupMessage(parsed.data)
      ? undefined
      : parsed.data.platform === "telegram"
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
    const result = groupConversationId
      ? await sharedRestMessageSend(
          agent,
          groupConversationId,
          deliveryMessage,
          agent.agent_name ?? "Eliza",
          worker.executionCtx,
          worker.namespace,
          parsed.data.messageId,
          "platform",
          undefined,
          undefined,
          { type: ChannelType.GROUP, source: parsed.data.platform },
        )
      : await sharedRestMessageSend(
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
    // The same values ship on `Server-Timing` below; a second uncorrelated
    // per-turn log on the hot path would only duplicate them.
    const providerTiming = sharedTurnServerTiming(result.timing);
    c.header(
      "Server-Timing",
      [
        accountTiming,
        `prewarm;dur=${prewarmMs.toFixed(1)}`,
        `shared;dur=${(performance.now() - sharedStartedAt).toFixed(1)}`,
        providerTiming,
      ]
        .filter(Boolean)
        .join(", "),
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
        ...(groupDeliveryAuthority
          ? {
              groupDelivery: {
                kind: "binding" as const,
                authority: groupDeliveryAuthority,
              },
            }
          : {}),
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
      ...(error instanceof PersonalDeliveryAccountResolutionError
        ? { projectionFailure: error.projectionFailure }
        : {}),
      ...(isGroupDeliveryPendingError(error)
        ? {
            deliveryState: "live_reservation_pending",
            operatorAction:
              "retry after the active uncommitted delivery lease expires",
          }
        : {}),
    });
    // This route is internal-authenticated. Safe classification headers let
    // the connector correlate a retry without exposing exception messages or
    // provider/SQL payloads in its logs.
    c.header(FAILURE_STAGE_HEADER, stage);
    c.header(FAILURE_NAME_HEADER, errorName);
    if (error instanceof PersonalDeliveryAccountResolutionError) {
      // Account resolution only fails here after both the projection and the
      // canonical resolver failed — a transient storage condition the
      // connector should retry, not an opaque terminal 500.
      return c.json(
        {
          success: false,
          error:
            "Account resolution is temporarily unavailable. Retry this turn shortly.",
          code: "service_unavailable",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
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
    if (isGroupDeliveryPendingError(error)) {
      return c.json(
        {
          success: false,
          error:
            "A provider delivery reservation is still active. Group authority was not changed; retry shortly.",
          code: "group_delivery_pending",
          retryable: true,
        },
        409,
        { "Retry-After": "5" },
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
