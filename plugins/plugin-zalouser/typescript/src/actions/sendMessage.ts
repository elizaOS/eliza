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
import { ZALOUSER_SERVICE_NAME } from "../constants";
import type { ZaloUserService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_ZALOUSER_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "ZALOUSER_SEND_MESSAGE",
    "ZALOUSER_REPLY",
    "ZALOUSER_MESSAGE",
    "SEND_ZALO",
    "REPLY_ZALO",
    "ZALO_SEND",
    "ZALO_MESSAGE",
  ],
  description: "Send a message to a Zalo chat via personal account",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "zalouser";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const zaloService = runtime.getService(ZALOUSER_SERVICE_NAME) as
      | ZaloUserService
      | undefined;

    if (!zaloService) {
      if (callback) {
        await callback({
          text: "Zalo User service not available",
        });
      }
      return { success: false, error: "Zalo User service not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const responseText = currentState.values?.response?.toString() || "";
    const threadId = message.content?.threadId as string | undefined;

    if (!threadId) {
      if (callback) {
        await callback({
          text: "No thread ID available",
        });
      }
      return { success: false, error: "Missing thread ID" };
    }

    // Send the message
    const result = await zaloService.sendMessage({
      threadId,
      text: responseText,
      isGroup: message.content?.isGroup as boolean | undefined,
    });

    if (!result.success) {
      if (callback) {
        await callback({
          text: `Failed to send message: ${result.error}`,
        });
      }
      return { success: false, error: result.error };
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
        threadId,
        text: responseText,
        messageId: result.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Zalo chat",
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
