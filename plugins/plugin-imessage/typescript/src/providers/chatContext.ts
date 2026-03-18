/**
 * Chat context provider for the iMessage plugin.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { IMessageService } from "../service.js";
import { IMESSAGE_SERVICE_NAME } from "../types.js";

export const chatContextProvider: Provider = {
  name: "imessageChatContext",
  description: "Provides information about the current iMessage chat context",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    // Only provide context for iMessage messages
    if (message.content.source !== "imessage") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const imessageService = await runtime.getService<IMessageService>(
      IMESSAGE_SERVICE_NAME,
    );

    if (!imessageService || !imessageService.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: false },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";
    const stateData = (state?.data || {}) as Record<string, unknown>;

    const handle = stateData.handle as string | undefined;
    const chatId = stateData.chatId as string | undefined;
    const chatType = stateData.chatType as string | undefined;
    const displayName = stateData.displayName as string | undefined;

    let chatDescription = "";
    if (chatType === "group") {
      chatDescription = displayName
        ? `group chat "${displayName}"`
        : "a group chat";
    } else {
      chatDescription = handle
        ? `direct message with ${handle}`
        : "a direct message";
    }

    const responseText =
      `${agentName} is chatting via iMessage in ${chatDescription}. ` +
      "iMessage supports text messages and attachments.";

    return {
      data: {
        handle,
        chatId,
        chatType: chatType || "direct",
        displayName,
        connected: true,
        platform: "imessage",
      },
      values: {
        handle,
        chatId,
        chatType: chatType || "direct",
        displayName,
      },
      text: responseText,
    };
  },
};
