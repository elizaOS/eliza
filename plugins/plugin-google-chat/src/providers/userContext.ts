/**
 * User context provider for Google Chat plugin.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import {
  extractResourceId,
  GOOGLE_CHAT_SERVICE_NAME,
  type GoogleChatUser,
  getUserDisplayName,
} from "../types.js";

export const userContextProvider: Provider = {
  name: "googleChatUserContext",
  description: "Provides information about the Google Chat user in the current conversation",

  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    if (message.content.source !== "google-chat") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const gchatService = runtime.getService<GoogleChatService>(GOOGLE_CHAT_SERVICE_NAME);

    if (!gchatService || !gchatService.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: false },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";

    const sender = state?.data?.sender as GoogleChatUser | undefined;

    if (!sender) {
      return {
        data: { connected: true },
        values: { connected: true },
        text: "",
      };
    }

    const userName = sender.name;
    const displayName = getUserDisplayName(sender);
    const userId = extractResourceId(userName);
    const email = sender.email;
    const userType = sender.type;

    let responseText = `${agentName} is talking to ${displayName}`;
    if (email) {
      responseText += ` (${email})`;
    }
    responseText += " on Google Chat.";

    if (userType === "BOT") {
      responseText += " This user is a bot.";
    }

    return {
      data: {
        userName,
        userId,
        displayName,
        email: email || undefined,
        userType: userType || "HUMAN",
        isBot: userType === "BOT",
      },
      values: {
        userName,
        userId,
        displayName,
        email: email || undefined,
      },
      text: responseText,
    };
  },
};
