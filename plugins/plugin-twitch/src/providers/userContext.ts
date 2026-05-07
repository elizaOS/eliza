/**
 * User context provider for Twitch plugin.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { TwitchService } from "../service.js";
import {
  getTwitchUserDisplayName,
  TWITCH_SERVICE_NAME,
  type TwitchUserInfo,
} from "../types.js";

const MAX_TWITCH_FIELD_LENGTH = 200;

function truncateField(value: string | undefined): string | undefined {
  return value ? value.slice(0, MAX_TWITCH_FIELD_LENGTH) : value;
}
/**
 * Provider that gives the agent information about the Twitch user context.
 */
export const userContextProvider: Provider = {
  name: "twitchUserContext",
  description:
    "Provides information about the Twitch user in the current conversation",
  descriptionCompressed: "provide information Twitch user current conversation",

  dynamic: true,
  contextGate: { anyOf: ["social", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  contexts: ["social", "connectors"],
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    // Only provide context for Twitch messages
    if (message.content.source !== "twitch") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const twitchService =
      runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);

    if (!twitchService?.isConnected()) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";

    // Try to get user info from message metadata
    const metadata = message.content.metadata as
      | Record<string, unknown>
      | undefined;
    const userInfo = metadata?.user as TwitchUserInfo | undefined;

    if (!userInfo) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    try {
      const displayName =
        truncateField(getTwitchUserDisplayName(userInfo)) ?? "";
      const username = truncateField(userInfo.username) ?? userInfo.username;
      const roles: string[] = [];

      if (userInfo.isBroadcaster) {
        roles.push("broadcaster");
      }
      if (userInfo.isModerator) {
        roles.push("moderator");
      }
      if (userInfo.isVip) {
        roles.push("VIP");
      }
      if (userInfo.isSubscriber) {
        roles.push("subscriber");
      }

      const roleText = roles.length > 0 ? roles.join(", ") : "viewer";

      let responseText = `${agentName} is talking to ${displayName} (${roleText}) in Twitch chat.`;

      if (userInfo.isBroadcaster) {
        responseText += ` ${displayName} is the channel owner/broadcaster.`;
      } else if (userInfo.isModerator) {
        responseText += ` ${displayName} is a channel moderator.`;
      }

      return {
        data: {
          userId: userInfo.userId,
          username,
          displayName,
          isBroadcaster: userInfo.isBroadcaster,
          isModerator: userInfo.isModerator,
          isVip: userInfo.isVip,
          isSubscriber: userInfo.isSubscriber,
          roles,
          color: userInfo.color,
        },
        values: {
          userId: userInfo.userId,
          username,
          displayName,
          roleText,
          isBroadcaster: userInfo.isBroadcaster,
          isModerator: userInfo.isModerator,
        },
        text: responseText,
      };
    } catch (error) {
      return {
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
        values: {},
        text: "",
      };
    }
  },
};
