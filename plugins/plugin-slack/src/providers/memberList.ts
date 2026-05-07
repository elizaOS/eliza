import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { SlackService } from "../service";
import { getSlackUserDisplayName, ServiceType } from "../types";

/**
 * Provider for retrieving Slack channel member information.
 */
export const memberListProvider: Provider = {
  name: "slackMemberList",
  description:
    "Provides information about members in the current Slack channel",
  dynamic: true,
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  cacheScope: "conversation",
  roleGate: { minRole: "ADMIN" },
  relevanceKeywords: [
    "slackmemberlist",
    "memberlistprovider",
    "plugin",
    "slack",
    "status",
    "state",
    "context",
    "info",
    "details",
    "chat",
    "conversation",
    "agent",
    "room",
    "channel",
  ],
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const __providerKeywords = [
      "slackmemberlist",
      "memberlistprovider",
      "plugin",
      "slack",
      "status",
      "state",
      "context",
      "info",
      "details",
      "chat",
      "conversation",
      "agent",
      "room",
      "channel",
    ];
    const __providerRegex = new RegExp(
      `\\b(${__providerKeywords.join("|")})\\b`,
      "i",
    );
    const __recentMessages =
      (state?.recentMessagesData as Memory[] | undefined) ?? [];
    const __isRelevant =
      validateActionKeywords(message, __recentMessages, __providerKeywords) ||
      validateActionRegex(message, __recentMessages, __providerRegex);
    if (!__isRelevant) {
      return { text: "" };
    }

    // If message source is not slack, return empty
    if (message.content.source !== "slack") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room?.channelId) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const slackService = runtime.getService(ServiceType.SLACK) as SlackService;
    if (!slackService?.client) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const channelId = room.channelId;

    // Get channel members
    try {
      const membersResult = await slackService.client.conversations.members({
        channel: channelId,
        limit: 100,
      });

      const memberIds = membersResult.members || [];

      if (memberIds.length === 0) {
        return {
          data: {
            channelId,
            memberCount: 0,
            members: [],
          },
          values: {
            memberCount: 0,
          },
          text: "No members found in this channel.",
        };
      }

      // Get user info for each member (limited to first 20 for performance)
      const memberLimit = 20;
      const limitedMemberIds = memberIds.slice(0, memberLimit);
      const members: Array<{
        id: string;
        name: string;
        displayName: string;
        isBot: boolean;
        isAdmin: boolean;
      }> = [];

      for (const memberId of limitedMemberIds) {
        const user = await slackService.getUser(memberId);
        if (user) {
          members.push({
            id: user.id,
            name: user.name,
            displayName: getSlackUserDisplayName(user),
            isBot: user.isBot,
            isAdmin: user.isAdmin || user.isOwner,
          });
        }
      }

      // Get channel info for name
      const channel = await slackService.getChannel(channelId);
      const channelName = channel?.name || channelId;

      // Format member list
      const botUserId = slackService.getBotUserId();
      const memberDescriptions = members.map((m) => {
        const tags: string[] = [];
        if (m.id === botUserId) tags.push("this bot");
        if (m.isBot && m.id !== botUserId) tags.push("bot");
        if (m.isAdmin) tags.push("admin");
        const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        return `- ${m.displayName} (@${m.name})${tagStr}`;
      });

      const truncationNote =
        memberIds.length > memberLimit
          ? `\n\n(Showing ${memberLimit} of ${memberIds.length} total members)`
          : "";

      const responseText = `Members in #${channelName}:\n${memberDescriptions.join("\n")}${truncationNote}`;

      return {
        data: {
          channelId,
          channelName,
          memberCount: memberIds.length,
          members,
          hasMoreMembers: memberIds.length > memberLimit,
        },
        values: {
          channelId,
          channelName,
          memberCount: memberIds.length,
        },
        text: responseText,
      };
    } catch (error) {
      return {
        data: {
          channelId,
          memberCount: 0,
          members: [],
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          channelId,
          memberCount: 0,
          slackMembersAvailable: false,
        },
        text: "Slack member list unavailable.",
      };
    }
  },
};

export default memberListProvider;
