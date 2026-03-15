/**
 * Send image action for the Zalo User plugin.
 *
 * Sends an image URL to a Zalo chat thread via personal account.
 * Maps to the classic "image" tool action.
 */

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

export const SEND_IMAGE_ACTION = "SEND_ZALOUSER_IMAGE";

export const sendImageAction: Action = {
  name: SEND_IMAGE_ACTION,
  similes: [
    "ZALOUSER_SEND_IMAGE",
    "ZALOUSER_IMAGE",
    "ZALO_SEND_IMAGE",
    "ZALO_IMAGE",
    "ZALO_SEND_PHOTO",
  ],
  description: "Send an image to a Zalo chat via personal account",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return message.content?.source === "zalouser";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = await runtime.getService(ZALOUSER_SERVICE_NAME) as
      | ZaloUserService
      | undefined;

    if (!service) {
      if (callback) {
        await callback({ text: "Zalo User service not available" });
      }
      return { success: false, error: "Zalo User service not initialized" };
    }

    const threadId = message.content?.threadId as string | undefined;
    const imageUrl = (message.content?.url as string) ||
      (message.content?.imageUrl as string) || "";
    const caption = (message.content?.caption as string) ||
      (message.content?.message as string) || "";
    const isGroup = message.content?.isGroup as boolean | undefined;

    if (!threadId) {
      if (callback) {
        await callback({ text: "No thread ID available" });
      }
      return { success: false, error: "Missing thread ID" };
    }

    if (!imageUrl.trim()) {
      if (callback) {
        await callback({ text: "Image URL is required" });
      }
      return { success: false, error: "Missing image URL" };
    }

    const result = await service.sendMedia({
      threadId,
      mediaUrl: imageUrl,
      caption: caption || undefined,
      isGroup,
    });

    if (!result.success) {
      if (callback) {
        await callback({ text: `Failed to send image: ${result.error}` });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      await callback({
        text: caption || "Image sent.",
        action: SEND_IMAGE_ACTION,
      });
    }

    return {
      success: true,
      data: {
        action: SEND_IMAGE_ACTION,
        threadId,
        imageUrl,
        messageId: result.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Send this photo to the Zalo chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sending the image now.",
          actions: [SEND_IMAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
