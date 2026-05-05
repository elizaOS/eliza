/**
 * Space state provider for Google Chat plugin.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import { GOOGLE_CHAT_SERVICE_NAME } from "../types.js";

export const spaceStateProvider: Provider = {
  name: "googleChatSpaceState",
  description: "Provides information about the current Google Chat space context",
  descriptionCompressed: "provide information current Google Chat space context",

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

    if (!gchatService?.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: false },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";

    const space = state?.data?.space as Record<string, unknown> | undefined;
    const spaceName = space?.name as string | undefined;
    const spaceDisplayName = space?.displayName as string | undefined;
    const spaceType = space?.type as string | undefined;
    const isThreaded = space?.threaded as boolean | undefined;
    const isDm = spaceType === "DM" || space?.singleUserBotDm === true;

    let responseText = "";

    if (isDm) {
      responseText = `${agentName} is in a direct message conversation on Google Chat.`;
    } else {
      const label = spaceDisplayName || spaceName || "a Google Chat space";
      responseText = `${agentName} is currently in Google Chat space "${label}".`;
      if (isThreaded) {
        responseText += " This space uses threaded conversations.";
      }
    }

    responseText += `\n\nGoogle Chat is Google Workspace's team communication platform.`;

    return {
      data: {
        spaceName,
        spaceDisplayName,
        spaceType,
        isThreaded: isThreaded || false,
        isDirect: isDm || false,
        connected: true,
      },
      values: {
        spaceName,
        spaceDisplayName,
        spaceType,
        isThreaded: isThreaded || false,
        isDirect: isDm || false,
      },
      text: responseText,
    };
  },
};
