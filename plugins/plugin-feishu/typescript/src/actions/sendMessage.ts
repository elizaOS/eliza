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
import { FEISHU_SERVICE_NAME } from "../constants";
import type { FeishuService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_FEISHU_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "FEISHU_SEND_MESSAGE",
    "FEISHU_REPLY",
    "FEISHU_MESSAGE",
    "SEND_FEISHU",
    "REPLY_FEISHU",
    "LARK_SEND_MESSAGE",
    "LARK_REPLY",
    "SEND_LARK",
  ],
  description: "Send a message to a Feishu/Lark chat",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "feishu";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const feishuService = runtime.getService(FEISHU_SERVICE_NAME) as unknown as
      | FeishuService
      | undefined;

    if (!feishuService) {
      if (callback) {
        await callback({
          text: "Feishu service not available",
        });
      }
      return { success: false, error: "Feishu service not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const responseText = currentState.values?.response?.toString() || "";
    const chatId = message.content?.chatId as string | undefined;

    if (!chatId) {
      if (callback) {
        await callback({
          text: "No chat ID available",
        });
      }
      return { success: false, error: "Missing chat ID" };
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
        chatId,
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
          text: "Send a message to this Feishu chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a message to this chat now.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
