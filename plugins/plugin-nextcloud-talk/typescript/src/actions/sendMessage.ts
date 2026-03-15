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
import { NEXTCLOUD_TALK_SERVICE_NAME } from "../constants";
import type { NextcloudTalkService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_NEXTCLOUD_TALK_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "NEXTCLOUD_TALK_SEND_MESSAGE",
    "NEXTCLOUD_TALK_REPLY",
    "NEXTCLOUD_TALK_MESSAGE",
    "NC_TALK_SEND",
    "NC_TALK_REPLY",
  ],
  description: "Send a message to a Nextcloud Talk room",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    return source === "nextcloud-talk";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = (await runtime.getService(NEXTCLOUD_TALK_SERVICE_NAME)) as
      | NextcloudTalkService
      | undefined;

    if (!service) {
      if (callback) {
        await callback({
          text: "Nextcloud Talk service not available",
        });
      }
      return { success: false, error: "Nextcloud Talk service not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const responseText = currentState.values?.response?.toString() || "";
    const roomToken = message.content?.roomToken as string | undefined;

    if (!roomToken) {
      if (callback) {
        await callback({
          text: "No room token available",
        });
      }
      return { success: false, error: "Missing room token" };
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
        roomToken,
        text: responseText,
        replyToMessageId: message.content?.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Nextcloud Talk room",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a message to this room now.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
