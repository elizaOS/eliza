/**
 * Minimal dispatch helpers retained from the now-deleted cross-channel-send.ts.
 *
 * Only covers post-approval send_message dispatch (telegram, discord, imessage,
 * sms, x_dm). The Wave 2 OwnerSendPolicy + core triage stack is the canonical
 * path for new outbound flows; this surface exists for legacy approval-queue
 * entries whose payload action is still "send_message".
 */

import type { ActionResult, IAgentRuntime } from "@elizaos/core";
import type { LifeOpsService } from "../../lifeops/service.js";
import {
  readTwilioCredentialsFromEnv,
  sendTwilioSms,
} from "../../lifeops/twilio.js";

export type CrossChannelSendChannel =
  | "telegram"
  | "discord"
  | "imessage"
  | "sms"
  | "x_dm";

export interface DispatchCrossChannelSendArgs {
  runtime: IAgentRuntime;
  service: LifeOpsService;
  channel: CrossChannelSendChannel;
  target: string;
  body: string;
}

type LegacyMessagingService = LifeOpsService & {
  sendTelegramMessage?: (args: {
    target: string;
    message: string;
  }) => Promise<unknown>;
  sendIMessage?: (args: { to: string; text: string }) => Promise<unknown>;
};

function ok(channel: string, target: string, body: string): ActionResult {
  return {
    text: `Sent ${channel} to ${target}.`,
    success: true,
    values: { success: true, channel, target },
    data: { channel, target, message: body },
  };
}

function fail(
  channel: string,
  target: string,
  body: string,
  error: string,
): ActionResult {
  return {
    text: `${channel} dispatch to ${target} failed: ${error}.`,
    success: false,
    values: { success: false, channel, target, error },
    data: { channel, target, message: body },
  };
}

export async function dispatchCrossChannelSend(
  args: DispatchCrossChannelSendArgs,
): Promise<ActionResult> {
  const { service, channel, target, body } = args;
  switch (channel) {
    case "telegram": {
      try {
        const messagingService = service as LegacyMessagingService;
        if (typeof messagingService.sendTelegramMessage === "function") {
          try {
            await messagingService.sendTelegramMessage({
              target,
              message: body,
            });
            return ok(channel, target, body);
          } catch {
            // Fall through to the runtime connector path. Test and desktop
            // runtimes often expose Telegram through sendMessageToTarget rather
            // than LifeOpsService credentials.
          }
        }
        await args.runtime.sendMessageToTarget(
          { source: "telegram", channelId: target } as Parameters<
            typeof args.runtime.sendMessageToTarget
          >[0],
          { text: body, source: "telegram" },
        );
        return ok(channel, target, body);
      } catch (error) {
        return fail(
          channel,
          target,
          body,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    case "discord": {
      try {
        await args.runtime.sendMessageToTarget(
          { source: "discord", channelId: target } as Parameters<
            typeof args.runtime.sendMessageToTarget
          >[0],
          { text: body, source: "discord" },
        );
        return ok(channel, target, body);
      } catch (error) {
        return fail(
          channel,
          target,
          body,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    case "imessage": {
      try {
        const messagingService = service as LegacyMessagingService;
        await messagingService.sendIMessage?.({ to: target, text: body });
        return ok(channel, target, body);
      } catch (error) {
        return fail(
          channel,
          target,
          body,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    case "sms": {
      const credentials = readTwilioCredentialsFromEnv();
      if (!credentials) {
        return fail(channel, target, body, "Twilio is not configured");
      }
      const result = await sendTwilioSms({ credentials, to: target, body });
      return result.ok
        ? ok(channel, target, body)
        : fail(channel, target, body, result.error ?? "DISPATCH_FAILED");
    }
    case "x_dm": {
      const result = await service.sendXDirectMessage({
        participantId: target,
        text: body,
        confirmSend: true,
        side: "owner",
      });
      return result.ok
        ? ok(channel, target, body)
        : fail(channel, target, body, result.error ?? "Failed to send X DM");
    }
  }
}
