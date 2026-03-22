/**
 * Send link action for the Zalo User plugin.
 *
 * Sends a URL/link message to a Zalo chat thread via personal account.
 * Maps to the classic "link" tool action.
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

export const SEND_LINK_ACTION = "SEND_ZALOUSER_LINK";

export const sendLinkAction: Action = {
  name: SEND_LINK_ACTION,
  similes: [
    "ZALOUSER_SEND_LINK",
    "ZALOUSER_LINK",
    "ZALO_SEND_LINK",
    "ZALO_LINK",
    "ZALO_SHARE_URL",
  ],
  description: "Send a link/URL to a Zalo chat via personal account",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return message.content?.source === "zalouser";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
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
    const url = (message.content?.url as string) ||
      (message.content?.link as string) || "";
    const isGroup = message.content?.isGroup as boolean | undefined;

    if (!threadId) {
      if (callback) {
        await callback({ text: "No thread ID available" });
      }
      return { success: false, error: "Missing thread ID" };
    }

    if (!url.trim()) {
      if (callback) {
        await callback({ text: "URL is required" });
      }
      return { success: false, error: "Missing URL" };
    }

    const result = await service.sendMedia({
      threadId,
      mediaUrl: url,
      isGroup,
    });

    if (!result.success) {
      if (callback) {
        await callback({ text: `Failed to send link: ${result.error}` });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      await callback({
        text: `Link shared: ${url}`,
        action: SEND_LINK_ACTION,
      });
    }

    return {
      success: true,
      data: {
        action: SEND_LINK_ACTION,
        threadId,
        url,
        messageId: result.messageId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Share this link in the Zalo chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sharing the link now.",
          actions: [SEND_LINK_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
