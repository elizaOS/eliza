/**
 * Cross-channel draft/send action.
 *
 * Always drafts first. Callers must re-invoke with `confirmed: true` to
 * actually dispatch. Dispatch is routed per channel:
 *   - email         → LifeOpsService.sendGmailMessage
 *   - sms           → sendTwilioSms
 *   - twilio_voice  → sendTwilioVoiceCall
 *   - telegram      → LifeOpsService.sendTelegramMessage
 *   - discord       → runtime send handler registered for "discord"
 *   - signal        → runtime send handler registered for "signal"
 *   - imessage      → LifeOpsService.sendIMessage
 *   - whatsapp      → LifeOpsService.sendWhatsAppMessage
 *   - notifications → ntfy push (NTFY_BASE_URL)
 *   - calendly      → createCalendlySingleUseLink (target = event-type URI)
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import {
  createCalendlySingleUseLink,
  readCalendlyCredentialsFromEnv,
} from "../lifeops/calendly-client.js";
import { requireFeatureEnabled } from "../lifeops/feature-flags.js";
import {
  FeatureNotEnabledError,
  type LifeOpsFeatureKey,
} from "../lifeops/feature-flags.types.js";
import {
  NtfyConfigError,
  readNtfyConfigFromEnv,
  sendPush,
} from "../lifeops/notifications-push.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
  type TwilioDeliveryResult,
} from "../lifeops/twilio.js";
import { recentConversationTexts } from "./life-recent-context.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

const ACTION_NAME = "OWNER_SEND_MESSAGE";

export const CROSS_CHANNEL_SEND_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "signal",
  "sms",
  "twilio_voice",
  "imessage",
  "whatsapp",
  "notifications",
  "calendly",
  "x_dm",
] as const;
export type CrossChannelSendChannel =
  (typeof CROSS_CHANNEL_SEND_CHANNELS)[number];

type CrossChannelSendParameters = {
  channel?: string;
  target?: string;
  message?: string;
  subject?: string;
  confirmed?: boolean;
};

type CrossChannelSendLlmPlan = {
  channel?: string;
  target?: string;
  message?: string;
  subject?: string;
  confirmed?: boolean | null;
  shouldAct?: boolean | null;
  response?: string;
};

type PendingCrossChannelSendDraft = {
  channel: CrossChannelSendChannel;
  target: string;
  message: string;
  subject?: string | null;
  approvalTaskId?: string | null;
  createdAt: string;
};

type DispatchContext = {
  runtime: IAgentRuntime;
  service: LifeOpsService;
  channel: CrossChannelSendChannel;
  target: string;
  body: string;
  subject?: string;
};

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function isCrossChannelSendChannel(
  value: string,
): value is CrossChannelSendChannel {
  return (CROSS_CHANNEL_SEND_CHANNELS as readonly string[]).includes(value);
}

function normalizeChannelAlias(
  value: string | undefined,
): CrossChannelSendChannel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  const aliasMap: Record<string, CrossChannelSendChannel> = {
    sms: "sms",
    twilio_sms: "sms",
    twiliosms: "sms",
    twilio_voice: "twilio_voice",
    twiliovoice: "twilio_voice",
    email: "email",
    gmail: "email",
    telegram: "telegram",
    discord: "discord",
    signal: "signal",
    imessage: "imessage",
    whatsapp: "whatsapp",
    notifications: "notifications",
    notification: "notifications",
    push: "notifications",
    ntfy: "notifications",
    calendly: "calendly",
    x_dm: "x_dm",
    xdm: "x_dm",
    twitter_dm: "x_dm",
    twitterdm: "x_dm",
  };
  const canonical = aliasMap[normalized];
  if (canonical) {
    return canonical;
  }
  return isCrossChannelSendChannel(normalized) ? normalized : undefined;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlannerBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function getPendingDraftCacheKey(roomId: string): string {
  return `lifeops:cross-channel-send:pending:${roomId}`;
}

async function readPendingDraft(
  runtime: IAgentRuntime,
  roomId: string,
): Promise<PendingCrossChannelSendDraft | null> {
  if (typeof runtime.getCache !== "function") {
    return null;
  }
  return (
    (await runtime.getCache<PendingCrossChannelSendDraft>(
      getPendingDraftCacheKey(roomId),
    )) ?? null
  );
}

async function writePendingDraft(
  runtime: IAgentRuntime,
  roomId: string,
  draft: PendingCrossChannelSendDraft,
): Promise<void> {
  if (typeof runtime.setCache !== "function") {
    return;
  }
  await runtime.setCache(getPendingDraftCacheKey(roomId), draft);
}

async function clearPendingDraft(
  runtime: IAgentRuntime,
  roomId: string,
): Promise<void> {
  if (typeof runtime.deleteCache !== "function") {
    return;
  }
  await runtime.deleteCache(getPendingDraftCacheKey(roomId));
}

async function resolveCrossChannelSendPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  pendingDraft: PendingCrossChannelSendDraft | null;
}): Promise<CrossChannelSendLlmPlan> {
  const currentMessage =
    typeof args.message.content?.text === "string"
      ? args.message.content.text.trim()
      : "";
  const recentConversation = (
    await recentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 8,
    })
  ).join("\n");
  const prompt = [
    "Plan the CROSS_CHANNEL_SEND action for this request.",
    "Use the current request, recent conversation, and any pending draft.",
    "Return a JSON object with exactly these fields:",
    "  channel: one of email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp, notifications, calendly, x_dm, or null",
    "  target: recipient identifier string or null",
    "  message: message body string or null",
    "  subject: email subject string or null",
    "  confirmed: boolean or null",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false or more context is needed",
    "",
    "Rules:",
    "- If the user is confirming a previously drafted send, keep the pending draft channel/target/message and set confirmed=true.",
    "- If the user is only stating a policy, preference, or future trigger, set shouldAct=false and explain the policy instead of fabricating a send.",
    "- Group-chat handoff suggestions are not sends. Set shouldAct=false and explain that you'll suggest a group-chat handoff when relay coordination gets messy.",
    "- For email, include a subject when the request implies one or a pending draft already has one.",
    "- Return only JSON.",
    "",
    "Examples:",
    '  current request: "send it" with pending draft {"channel":"sms","target":"+15555550101","message":"Running 10 minutes late."}',
    '  -> {"channel":"sms","target":"+15555550101","message":"Running 10 minutes late.","subject":null,"confirmed":true,"shouldAct":true,"response":null}',
    '  current request: "Email alice@example.com the notes from today" with no pending draft',
    '  -> {"channel":"email","target":"alice@example.com","message":"Here are the notes from today.","subject":"Notes from today","confirmed":false,"shouldAct":true,"response":null}',
    '  current request: "If direct relaying gets messy here, suggest making a group chat handoff instead."',
    '  -> {"channel":null,"target":null,"message":null,"subject":null,"confirmed":null,"shouldAct":false,"response":"If relay coordination gets messy, I will suggest moving everyone into a group chat handoff instead of continuing one-off relays."}',
    "",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Pending draft: ${JSON.stringify(args.pendingDraft)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: runtime.useModel is an elizaOS model API, not a React hook.
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      const fallbackResponse = rawResponse.trim();
      return fallbackResponse.length > 0
        ? {
            shouldAct: false,
            response: fallbackResponse,
          }
        : {};
    }
    return {
      channel: normalizePlannerResponse(parsed.channel),
      target: normalizePlannerResponse(parsed.target),
      message: normalizePlannerResponse(parsed.message),
      subject: normalizePlannerResponse(parsed.subject),
      confirmed: normalizePlannerBoolean(parsed.confirmed),
      shouldAct: normalizePlannerBoolean(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:cross-channel-send",
        error: error instanceof Error ? error.message : String(error),
      },
      "Cross-channel send planning model call failed",
    );
    return {};
  }
}

async function enqueueApprovalRequest(args: {
  runtime: IAgentRuntime;
  message: Memory;
  channel: CrossChannelSendChannel;
  target: string;
  body: string;
  subject?: string;
}): Promise<string | null> {
  if (typeof args.runtime.createTask !== "function") {
    return null;
  }
  return await args.runtime.createTask({
    name: `CROSS_CHANNEL_SEND_${Date.now()}`,
    description: `Approve sending ${args.channel} to ${args.target}${args.subject ? ` (${args.subject})` : ""}: ${args.body}`,
    roomId: args.message.roomId,
    entityId: args.message.entityId,
    tags: ["AWAITING_CHOICE", "APPROVAL", "CROSS_CHANNEL_SEND"],
    metadata: {
      options: [
        { name: "confirm", description: "Send the drafted message" },
        { name: "cancel", description: "Do not send it" },
      ],
      approvalRequest: {
        timeoutMs: 24 * 60 * 60 * 1000,
        timeoutDefault: "cancel",
        createdAt: Date.now(),
        isAsync: true,
      },
      actionName: ACTION_NAME,
      channel: args.channel,
      payload: {
        channel: args.channel,
        target: args.target,
        message: args.body,
        subject: args.subject ?? null,
      },
    },
  });
}

function twilioResultToActionResult(args: {
  channel: CrossChannelSendChannel;
  target: string;
  message: string;
  result: TwilioDeliveryResult;
}): ActionResult {
  const { channel, target, message, result } = args;
  if (!result.ok) {
    return {
      text: `${channel} dispatch to ${target} failed: ${result.error ?? "unknown error"}.`,
      success: false,
      values: {
        success: false,
        channel,
        target,
        error: result.error ?? "DISPATCH_FAILED",
        status: result.status,
      },
      data: {
        actionName: ACTION_NAME,
        channel,
        target,
        message,
        status: result.status,
        retryCount: result.retryCount,
      },
    };
  }
  return {
    text: `Sent ${channel} to ${target}.`,
    success: true,
    values: {
      success: true,
      channel,
      target,
      sid: result.sid ?? null,
    },
    data: {
      actionName: ACTION_NAME,
      channel,
      target,
      message,
      sid: result.sid ?? null,
      status: result.status,
      retryCount: result.retryCount,
    },
  };
}

async function dispatchViaRuntimeSendHandler(
  runtime: IAgentRuntime,
  channel: CrossChannelSendChannel,
  target: string,
  message: string,
): Promise<void> {
  await runtime.sendMessageToTarget(
    {
      source: channel,
      channelId: target,
    } as Parameters<typeof runtime.sendMessageToTarget>[0],
    {
      text: message,
      source: channel,
    },
  );
}

function buildDispatchFailure(args: {
  channel: CrossChannelSendChannel;
  target: string;
  body: string;
  error: string;
  subject?: string;
}): ActionResult {
  const { channel, target, body, error, subject } = args;
  return {
    text: `${channel} dispatch to ${target} failed: ${error}.`,
    success: false,
    values: { success: false, channel, target, error },
    data: {
      actionName: ACTION_NAME,
      channel,
      target,
      message: body,
      subject: subject ?? null,
    },
  };
}

function buildDispatchSuccess(args: {
  channel: CrossChannelSendChannel;
  target: string;
  body: string;
  subject?: string;
  result?: unknown;
}): ActionResult {
  const { channel, target, body, subject, result } = args;
  return {
    text: `Sent ${channel} to ${target}.`,
    success: true,
    values: { success: true, channel, target },
    data: {
      actionName: ACTION_NAME,
      channel,
      target,
      message: body,
      subject: subject ?? null,
      result: result as never,
    },
  };
}

function createLifeOpsMethodDispatcher(args: {
  method: string;
  buildRequest: (ctx: DispatchContext) => Record<string, unknown>;
}) {
  return async (ctx: DispatchContext): Promise<ActionResult> => {
    const serviceUnknown = ctx.service as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const method = serviceUnknown[args.method];
    if (typeof method !== "function") {
      return buildDispatchFailure({
        channel: ctx.channel,
        target: ctx.target,
        body: ctx.body,
        subject: ctx.subject,
        error: `${ctx.channel} send is unavailable because the required LifeOps connector method is not loaded`,
      });
    }

    try {
      const result = await method.call(ctx.service, args.buildRequest(ctx));
      return buildDispatchSuccess({
        channel: ctx.channel,
        target: ctx.target,
        body: ctx.body,
        subject: ctx.subject,
        result,
      });
    } catch (error) {
      return buildDispatchFailure({
        channel: ctx.channel,
        target: ctx.target,
        body: ctx.body,
        subject: ctx.subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

const CHANNEL_DISPATCHERS: Record<
  CrossChannelSendChannel,
  (ctx: DispatchContext) => Promise<ActionResult>
> = {
  sms: async ({ channel, target, body }) => {
    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
        success: false,
        values: { success: false, error: "TWILIO_NOT_CONFIGURED", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    const result = await sendTwilioSms({ credentials, to: target, body });
    return twilioResultToActionResult({
      channel,
      target,
      message: body,
      result,
    });
  },
  twilio_voice: async ({ channel, target, body }) => {
    const credentials = readTwilioCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
        success: false,
        values: { success: false, error: "TWILIO_NOT_CONFIGURED", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    const result = await sendTwilioVoiceCall({
      credentials,
      to: target,
      message: body,
    });
    return twilioResultToActionResult({
      channel,
      target,
      message: body,
      result,
    });
  },
  email: async ({ service, channel, target, body, subject }) => {
    if (!subject) {
      return {
        text: "Email send requires a subject.",
        success: false,
        values: { success: false, error: "MISSING_SUBJECT", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    const requestUrl = new URL("http://internal.invalid/lifeops/gmail/send");
    try {
      await service.sendGmailMessage(requestUrl, {
        to: [target],
        subject,
        bodyText: body,
        confirmSend: true,
      });
      return buildDispatchSuccess({ channel, target, body, subject });
    } catch (error) {
      return buildDispatchFailure({
        channel,
        target,
        body,
        subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  telegram: createLifeOpsMethodDispatcher({
    method: "sendTelegramMessage",
    buildRequest: ({ target, body }) => ({ target, message: body }),
  }),
  imessage: createLifeOpsMethodDispatcher({
    method: "sendIMessage",
    buildRequest: ({ target, body }) => ({ to: target, text: body }),
  }),
  whatsapp: createLifeOpsMethodDispatcher({
    method: "sendWhatsAppMessage",
    buildRequest: ({ target, body }) => ({ to: target, text: body }),
  }),
  discord: async ({ runtime, channel, target, body }) => {
    try {
      await dispatchViaRuntimeSendHandler(runtime, "discord", target, body);
      return buildDispatchSuccess({ channel, target, body });
    } catch (error) {
      return buildDispatchFailure({
        channel,
        target,
        body,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  signal: async ({ runtime, channel, target, body }) => {
    try {
      await dispatchViaRuntimeSendHandler(runtime, "signal", target, body);
      return buildDispatchSuccess({ channel, target, body });
    } catch (error) {
      return buildDispatchFailure({
        channel,
        target,
        body,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  notifications: async ({ channel, target, body, subject }) => {
    try {
      const config = readNtfyConfigFromEnv();
      const result = await sendPush(
        {
          topic: target || undefined,
          title: subject || "Notification",
          message: body,
        },
        config,
      );
      return buildDispatchSuccess({ channel, target, body, subject, result });
    } catch (error) {
      if (error instanceof NtfyConfigError) {
        return {
          text: `Push notifications are not configured. Set NTFY_BASE_URL (and optionally NTFY_DEFAULT_TOPIC).`,
          success: false,
          values: { success: false, error: "NTFY_NOT_CONFIGURED", channel },
          data: { actionName: ACTION_NAME, channel },
        };
      }
      return buildDispatchFailure({
        channel,
        target,
        body,
        subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  // target = Calendly event-type URI (e.g. the URI from the event type list).
  // body is ignored — this generates a single-use booking link.
  calendly: async ({ channel, target, body, subject }) => {
    const credentials = readCalendlyCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "Calendly is not configured. Set CALENDLY_API_KEY.",
        success: false,
        values: { success: false, error: "CALENDLY_NOT_CONFIGURED", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    if (!target) {
      return {
        text: "Calendly send requires a target event-type URI.",
        success: false,
        values: { success: false, error: "MISSING_TARGET", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    try {
      const result = await createCalendlySingleUseLink(credentials, target);
      const expiryText = result.expiresAt
        ? ` (expires ${result.expiresAt})`
        : "";
      return {
        text: `Calendly single-use booking link created: ${result.bookingUrl}${expiryText}`,
        success: true,
        values: {
          success: true,
          channel,
          target,
          bookingUrl: result.bookingUrl,
        },
        data: {
          actionName: ACTION_NAME,
          channel,
          target,
          message: body,
          subject: subject ?? null,
          result,
        },
      };
    } catch (error) {
      return buildDispatchFailure({
        channel,
        target,
        body,
        subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  x_dm: async ({ service, channel, target, body }) => {
    try {
      const conversationPrefix = "conversation:";
      const participantIds = target
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const result = target.startsWith(conversationPrefix)
        ? await service.sendXConversationMessage({
            conversationId: target.slice(conversationPrefix.length),
            text: body,
            confirmSend: true,
            side: "owner",
          })
        : participantIds.length > 1
          ? await service.createXDirectMessageGroup({
              participantIds,
              text: body,
              confirmSend: true,
              side: "owner",
            })
          : await service.sendXDirectMessage({
              participantId: target,
              text: body,
              confirmSend: true,
              side: "owner",
            });
      if (!result.ok) {
        return buildDispatchFailure({
          channel,
          target,
          body,
          error: result.error ?? "Failed to send X DM.",
        });
      }
      return {
        text: `Sent X DM to ${target}.`,
        success: true,
        values: {
          success: result.ok,
          channel,
          target,
        },
        data: {
          actionName: ACTION_NAME,
          channel,
          target,
          message: body,
          result,
        },
      };
    } catch (error) {
      return buildDispatchFailure({
        channel,
        target,
        body,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

export async function dispatchCrossChannelSend(
  ctx: DispatchContext,
): Promise<ActionResult> {
  return await CHANNEL_DISPATCHERS[ctx.channel](ctx);
}

export const crossChannelSendAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "CROSS_CHANNEL_SEND",
    "SEND_MESSAGE_TO",
    "DRAFT_MESSAGE",
    "SEND_ACROSS_CHANNEL",
    "POST_TO_CHANNEL",
    "POST_TO_DISCORD",
    "POST_TO_SLACK",
    "SEND_TELEGRAM",
    "SEND_SIGNAL",
    "SEND_WHATSAPP",
    "SEND_IMESSAGE",
    "SEND_SMS",
    "OWNER_DM",
    "REPLY_X_DM",
    "X_DM_REPLY",
    "OWNER_POST",
  ],
  description:
    "OWNER-scoped message send: the OWNER asks the agent to send a message " +
    "on the OWNER's behalf, using the OWNER's connected accounts (email, " +
    "telegram, discord, signal, sms, twilio_voice, imessage, whatsapp, " +
    "x_dm, notifications). Always drafts first; caller must re-invoke with " +
    "confirmed: true to dispatch. " +
    "Use this for any 'post <msg> to <channel>', 'send <msg> on <platform>', " +
    "or 'dm <person> on <platform>' request from the owner — the channel " +
    "name in the sentence (discord, telegram, signal, etc.) is the strongest " +
    "signal. " +
    "Do NOT use this for the AGENT's own outbound messages to people or the " +
    "owner (those use AGENT_SEND_MESSAGE). " +
    "Do NOT use this for 'broadcast/push/send <X> to all my devices' or " +
    "'broadcast a reminder to my phone/desktop/watch' — device-targeted " +
    "reminders belong to PUBLISH_DEVICE_INTENT. " +
    "Do NOT use OWNER_CALENDAR for channel-send requests even if the message " +
    "mentions a meeting-like word (e.g. 'standup', 'sync'); OWNER_CALENDAR " +
    "is for negotiating calendar proposals, not relaying chat messages.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasLifeOpsAccess(runtime, message),

  parameters: [
    {
      name: "channel",
      description: `Channel to send on. Use canonical values ${CROSS_CHANNEL_SEND_CHANNELS.join(", ")}. Alias inputs like twilio_sms, gmail, push, ntfy, and twitter_dm are also accepted and normalized.`,
      required: true,
      schema: {
        type: "string" as const,
        enum: [
          ...CROSS_CHANNEL_SEND_CHANNELS,
          "twilio_sms",
          "gmail",
          "push",
          "ntfy",
          "twitter_dm",
          "group_chat",
        ],
      },
    },
    {
      name: "target",
      description:
        "Recipient identifier. Email address for email, E.164 phone for sms/twilio_voice, handle/user ID for chat channels, numeric X user ID or comma-separated numeric X user IDs for x_dm, Ntfy topic name for notifications.",
      required: true,
      schema: { type: "string" as const },
      examples: ["+15555550101", "owner@example.test", "team-ops"],
    },
    {
      name: "message",
      description: "Message body (plaintext).",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "subject",
      description: "Email subject (email channel only).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Set to true to actually dispatch. Otherwise returns a draft preview.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Email alice@example.com the meeting notes" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft email to alice@example.com:\n\nSubject: Meeting notes\n\n"Here are the notes from today."\n\nSay "send it" to dispatch.',
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Text +15551234567 that I'll be 10 minutes late" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft sms to +15551234567:\n\n"I\'ll be 10 minutes late."\n\nSay "send it" to dispatch.',
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Call +15551234567 and say the build is done" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft twilio_voice to +15551234567:\n\n"The build is done."\n\nSay "send it" to dispatch.',
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Send Alice a Telegram: on my way" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft telegram to Alice:\n\n"On my way."\n\nSay "send it" to dispatch.',
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Send Priya a Signal message: thanks for the review" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft signal to Priya:\n\n"Thanks for the review."\n\nSay "send it" to dispatch.',
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "DM bob on Discord: standup in 5" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft discord to bob:\n\n"Standup in 5."\n\nSay "send it" to dispatch.',
          action: ACTION_NAME,
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may send messages.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as CrossChannelSendParameters;

    const pendingDraft = await readPendingDraft(runtime, message.roomId);
    const rawChannel = coerceString(params.channel);
    const planner =
      !rawChannel ||
      normalizeChannelAlias(rawChannel) === undefined ||
      !coerceString(params.target) ||
      !coerceString(params.message) ||
      coerceOptionalBool(params.confirmed) === undefined
        ? await resolveCrossChannelSendPlanWithLlm({
            runtime,
            message,
            state,
            pendingDraft,
          })
        : null;
    const normalizedChannel =
      normalizeChannelAlias(rawChannel) ??
      normalizeChannelAlias(planner?.channel) ??
      pendingDraft?.channel;
    const target =
      coerceString(params.target) ?? planner?.target ?? pendingDraft?.target;
    const body =
      coerceString(params.message) ?? planner?.message ?? pendingDraft?.message;
    const subject =
      coerceString(params.subject) ??
      planner?.subject ??
      pendingDraft?.subject ??
      undefined;
    const confirmed =
      coerceOptionalBool(params.confirmed) ?? planner?.confirmed ?? false;

    if (planner?.shouldAct === false && planner.response) {
      return {
        text: planner.response,
        success: true,
        values: {
          success: true,
          acted: false,
        },
        data: {
          actionName: ACTION_NAME,
          acted: false,
        },
      };
    }

    if (!normalizedChannel) {
      if (rawChannel) {
        return {
          text: `Unknown channel "${rawChannel}". Valid channels: ${CROSS_CHANNEL_SEND_CHANNELS.join(", ")}.`,
          success: false,
          values: {
            success: false,
            error: "UNKNOWN_CHANNEL",
            channel: rawChannel,
          },
          data: { actionName: ACTION_NAME },
        };
      }
      return {
        text: planner?.response ?? "Missing required parameter: channel.",
        success: false,
        values: { success: false, error: "MISSING_CHANNEL" },
        data: { actionName: ACTION_NAME },
      };
    }
    const channel: CrossChannelSendChannel = normalizedChannel;

    if (!target) {
      return {
        text: planner?.response ?? "Missing required parameter: target.",
        success: false,
        values: { success: false, error: "MISSING_TARGET", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    if (!body) {
      return {
        text: planner?.response ?? "Missing required parameter: message.",
        success: false,
        values: { success: false, error: "MISSING_MESSAGE", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }

    if (!confirmed) {
      const approvalTaskId = await enqueueApprovalRequest({
        runtime,
        message,
        channel,
        target,
        body,
        subject: subject ?? pendingDraft?.subject ?? undefined,
      });
      await writePendingDraft(runtime, message.roomId, {
        channel,
        target,
        message: body,
        subject: subject ?? pendingDraft?.subject ?? null,
        approvalTaskId,
        createdAt: new Date().toISOString(),
      });
      const subjectLine =
        channel === "email" && (subject ?? pendingDraft?.subject)
          ? `\nSubject: ${subject ?? pendingDraft?.subject}\n`
          : "";
      return {
        text: `Draft ${channel} to ${target}:\n${subjectLine}\n"${body}"\n\nRe-issue with confirmed: true to dispatch.`,
        success: true,
        values: {
          success: true,
          draft: true,
          channel,
          target,
          message: body,
          subject: subject ?? pendingDraft?.subject ?? null,
        },
        data: {
          actionName: ACTION_NAME,
          draft: true,
          channel,
          target,
          message: body,
          subject: subject ?? pendingDraft?.subject ?? null,
          approvalTaskId,
        },
      };
    }

    const requiredFeatures: LifeOpsFeatureKey[] = [];
    if (channel === "sms" || channel === "twilio_voice") {
      requiredFeatures.push("cross_channel.escalate");
    }
    if (channel === "notifications") {
      requiredFeatures.push("notifications.push");
    }
    for (const featureKey of requiredFeatures) {
      try {
        await requireFeatureEnabled(runtime, featureKey);
      } catch (error) {
        if (error instanceof FeatureNotEnabledError) {
          return {
            text: error.message,
            success: false,
            values: {
              success: false,
              error: error.code,
              featureKey: error.featureKey,
              channel,
            },
            data: {
              actionName: ACTION_NAME,
              error: error.code,
              featureKey: error.featureKey,
              channel,
            },
          };
        }
        throw error;
      }
    }

    const service = new LifeOpsService(runtime);
    const result = await CHANNEL_DISPATCHERS[channel]({
      runtime,
      service,
      channel,
      target,
      body,
      subject: subject ?? pendingDraft?.subject ?? undefined,
    });
    if (result.success) {
      await clearPendingDraft(runtime, message.roomId);
      const approvalTaskId = pendingDraft?.approvalTaskId;
      if (approvalTaskId) {
        await runtime.deleteTask(approvalTaskId as never);
      }
    }
    return result;
  },
};
