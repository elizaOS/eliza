/**
 * Unified cross-channel draft/send action.
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
 *   - x_dm          → X (Twitter) DM via X API v2 (requires x.write capability)
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent/security/access";
import {
  createCalendlySingleUseLink,
  readCalendlyCredentialsFromEnv,
} from "../lifeops/calendly-client.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
  sendTwilioVoiceCall,
  type TwilioDeliveryResult,
} from "../lifeops/twilio.js";
import {
  readNtfyConfigFromEnv,
  sendPush,
  NtfyConfigError,
} from "../lifeops/notifications-push.js";
import {
  readXPosterCredentialsFromEnv,
  sendXDm,
} from "../lifeops/x-poster.js";

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
export type CrossChannelSendChannel = (typeof CROSS_CHANNEL_SEND_CHANNELS)[number];

type CrossChannelSendParameters = {
  channel?: string;
  target?: string;
  message?: string;
  subject?: string;
  confirmed?: boolean;
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

function coerceBool(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function isCrossChannelSendChannel(
  value: string,
): value is CrossChannelSendChannel {
  return (CROSS_CHANNEL_SEND_CHANNELS as readonly string[]).includes(value);
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
        error:
          `${ctx.channel} send is unavailable because the required LifeOps connector method is not loaded`,
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
    return twilioResultToActionResult({ channel, target, message: body, result });
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
    return twilioResultToActionResult({ channel, target, message: body, result });
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
      return {
        text: `Calendly single-use booking link created: ${result.bookingUrl} (expires ${result.expiresAt})`,
        success: true,
        values: { success: true, channel, target, bookingUrl: result.bookingUrl },
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
  // target = recipient Twitter/X numeric user ID (not a @handle).
  // Requires X API v2 credentials with dm.write OAuth scope.
  x_dm: async ({ channel, target, body }) => {
    const credentials = readXPosterCredentialsFromEnv();
    if (!credentials) {
      return {
        text: "X (Twitter) is not configured. Set TWITTER_API_KEY, TWITTER_API_SECRET_KEY, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_TOKEN_SECRET.",
        success: false,
        values: { success: false, error: "X_NOT_CONFIGURED", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    const participantId = target.replace(/^@/, "").trim();
    if (!participantId) {
      return {
        text: "X DM requires a target numeric user ID.",
        success: false,
        values: { success: false, error: "MISSING_TARGET", channel },
        data: { actionName: ACTION_NAME, channel },
      };
    }
    const result = await sendXDm({ participantId, text: body, credentials });
    if (!result.ok) {
      return buildDispatchFailure({
        channel,
        target,
        body,
        error: result.error ?? "X DM dispatch failed",
      });
    }
    return buildDispatchSuccess({
      channel,
      target,
      body,
      result: {
        dmConversationId: result.dmConversationId ?? null,
        dmEventId: result.dmEventId ?? null,
      },
    });
  },
};

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
    "OWNER_POST",
  ],
  description:
    "OWNER-scoped message send: the OWNER asks the agent to send a message " +
    "on the OWNER's behalf, using the OWNER's connected accounts (email, " +
    "telegram, discord, signal, sms, twilio_voice, imessage, whatsapp, " +
    "notifications). Always drafts first; caller must re-invoke with " +
    "confirmed: true to dispatch. " +
    "Use this for any 'post <msg> to <channel>', 'send <msg> on <platform>', " +
    "or 'dm <person> on <platform>' request from the owner — the channel " +
    "name in the sentence (discord, telegram, signal, etc.) is the strongest " +
    "signal. " +
    "Do NOT use this for the AGENT's own outbound messages to people or the " +
    "owner (those use AGENT_SEND_MESSAGE). " +
    "Do NOT use this for 'broadcast/push/send <X> to all my devices' or " +
    "'broadcast a reminder to my phone/desktop/watch' — device-targeted " +
    "reminders belong to INTENT_SYNC. " +
    "Do NOT use OWNER_CALENDAR for channel-send requests even if the message " +
    "mentions a meeting-like word (e.g. 'standup', 'sync'); OWNER_CALENDAR " +
    "is for negotiating calendar proposals, not relaying chat messages.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasAdminAccess(runtime, message),

  parameters: [
    {
      name: "channel",
      description: `Channel to send on. One of: ${CROSS_CHANNEL_SEND_CHANNELS.join(", ")}.`,
      required: true,
      schema: {
        type: "string" as const,
        enum: [...CROSS_CHANNEL_SEND_CHANNELS],
      },
    },
    {
      name: "target",
      description:
        "Recipient identifier. Email address for email, E.164 phone for sms/twilio_voice, handle/user ID for chat channels, Ntfy topic name for notifications.",
      required: true,
      schema: { type: "string" as const },
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
      { name: "{{name1}}", content: { text: "Email alice@example.com the meeting notes" } },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft email to alice@example.com:\n\nSubject: Meeting notes\n\n"Here are the notes from today."\n\nSay "send it" to dispatch.',
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "Text +15551234567 that I'll be 10 minutes late" } },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft sms to +15551234567:\n\n"I\'ll be 10 minutes late."\n\nSay "send it" to dispatch.',
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "Call +15551234567 and say the build is done" } },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft twilio_voice to +15551234567:\n\n"The build is done."\n\nSay "send it" to dispatch.',
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "Send Alice a Telegram: on my way" } },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft telegram to Alice:\n\n"On my way."\n\nSay "send it" to dispatch.',
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "DM bob on Discord: standup in 5" } },
      {
        name: "{{agentName}}",
        content: {
          text: 'Draft discord to bob:\n\n"Standup in 5."\n\nSay "send it" to dispatch.',
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admin may send messages.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as CrossChannelSendParameters;

    const rawChannel = coerceString(params.channel);
    const target = coerceString(params.target);
    const body = coerceString(params.message);
    const subject = coerceString(params.subject);
    const confirmed = coerceBool(params.confirmed);

    if (!rawChannel) {
      return {
        text: "Missing required parameter: channel.",
        success: false,
        values: { success: false, error: "MISSING_CHANNEL" },
        data: { actionName: ACTION_NAME },
      };
    }
    if (!isCrossChannelSendChannel(rawChannel)) {
      return {
        text: `Unknown channel "${rawChannel}". Valid channels: ${CROSS_CHANNEL_SEND_CHANNELS.join(", ")}.`,
        success: false,
        values: { success: false, error: "UNKNOWN_CHANNEL", channel: rawChannel },
        data: { actionName: ACTION_NAME },
      };
    }
    const channel: CrossChannelSendChannel = rawChannel;

    if (!target) {
      return {
        text: "Missing required parameter: target.",
        success: false,
        values: { success: false, error: "MISSING_TARGET" },
        data: { actionName: ACTION_NAME },
      };
    }
    if (!body) {
      return {
        text: "Missing required parameter: message.",
        success: false,
        values: { success: false, error: "MISSING_MESSAGE" },
        data: { actionName: ACTION_NAME },
      };
    }

    if (!confirmed) {
      const subjectLine =
        channel === "email" && subject ? `\nSubject: ${subject}\n` : "";
      return {
        text: `Draft ${channel} to ${target}:\n${subjectLine}\n"${body}"\n\nRe-issue with confirmed: true to dispatch.`,
        success: true,
        values: {
          success: true,
          draft: true,
          channel,
          target,
          message: body,
          subject: subject ?? null,
        },
        data: {
          actionName: ACTION_NAME,
          draft: true,
          channel,
          target,
          message: body,
          subject: subject ?? null,
        },
      };
    }

    const service = new LifeOpsService(runtime);
    return CHANNEL_DISPATCHERS[channel]({
      runtime,
      service,
      channel,
      target,
      body,
      subject,
    });
  },
};
