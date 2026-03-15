import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { TLON_SERVICE_NAME } from "../constants";
import type { TlonService } from "../service";
import type { TlonContent } from "../types";

export const SEND_MESSAGE_ACTION = "SEND_TLON_MESSAGE";

/**
 * Action for sending messages via Tlon/Urbit
 */
export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "TLON_SEND_MESSAGE",
    "TLON_REPLY",
    "TLON_MESSAGE",
    "SEND_TLON",
    "REPLY_TLON",
    "URBIT_SEND_MESSAGE",
    "URBIT_MESSAGE",
    "SEND_URBIT",
  ],
  description: "Send a message via Tlon/Urbit to a ship or channel",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "tlon" || source === "urbit";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const tlonService = (await runtime.getService(TLON_SERVICE_NAME)) as
      | TlonService
      | undefined;

    if (!tlonService) {
      if (callback) {
        await callback({
          text: "Tlon service not available",
        });
      }
      return { success: false, error: "Tlon service not initialized" };
    }

    const responseText = state?.values?.response?.toString() || "";
    const content = message.content as TlonContent;
    const channelId =
      content?.channelNest || (content as { chatId?: string })?.chatId;
    const ship = content?.ship;
    const replyToId = content?.replyToId;

    // Determine if this is a DM or channel message
    const isDm = ship && !channelId?.includes("/");

    try {
      if (isDm && ship) {
        await tlonService.sendDirectMessage(ship, responseText);
      } else if (channelId) {
        await tlonService.sendChannelMessage(
          channelId,
          responseText,
          replyToId,
        );
      } else {
        if (callback) {
          await callback({
            text: "No target ship or channel specified",
          });
        }
        return { success: false, error: "Missing target ship or channel" };
      }

      if (callback) {
        await callback({
          text: responseText,
          action: SEND_MESSAGE_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: SEND_MESSAGE_ACTION,
          channelId: channelId || ship,
          text: responseText,
          replyToId,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to send message: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Tlon chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a message via Tlon now.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Reply to this message on Urbit",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll reply to your message on Urbit.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
