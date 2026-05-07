import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { SlackService } from "../service";
import { ServiceType } from "../types";

/**
 * Provider for retrieving Slack workspace information.
 */
export const workspaceInfoProvider: Provider = {
  name: "slackWorkspaceInfo",
  description: "Provides information about the Slack workspace",
  dynamic: true,
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  cacheScope: "agent",
  roleGate: { minRole: "ADMIN" },
  relevanceKeywords: [
    "slackworkspaceinfo",
    "workspaceinfoprovider",
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
      "slackworkspaceinfo",
      "workspaceinfoprovider",
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

    const slackService = runtime.getService(ServiceType.SLACK) as SlackService;
    if (!slackService?.client) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    try {
      const teamId = slackService.getTeamId();
      const botUserId = slackService.getBotUserId();
      const isConnected = slackService.isServiceConnected();

      let workspaceName = "";
      let domain = "";

      // Get workspace info from world if available
      const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
      if (room?.worldId) {
        const world = await runtime.getWorld(room.worldId);
        if (world) {
          workspaceName = world.name;
          const worldMetadata = world.metadata as
            | Record<string, unknown>
            | undefined;
          domain = (worldMetadata?.domain as string) || "";
        }
      }

      // Get channel statistics
      const channels = await slackService.listChannels({
        types: "public_channel,private_channel",
      });
      const publicChannels = channels.filter(
        (ch) => !ch.isPrivate && !ch.isArchived,
      );
      const privateChannels = channels.filter(
        (ch) => ch.isPrivate && !ch.isArchived,
      );
      const memberChannels = channels.filter(
        (ch) => ch.isMember && !ch.isArchived,
      );

      // Get allowed channels
      const allowedChannelIds = slackService.getAllowedChannelIds();
      const hasChannelRestrictions = allowedChannelIds.length > 0;

      const agentName = state?.agentName || "The agent";

      let responseText = `${agentName} is connected to the Slack workspace`;
      if (workspaceName) {
        responseText += ` "${workspaceName}"`;
      }
      if (domain) {
        responseText += ` (${domain}.slack.com)`;
      }
      responseText += ".";

      responseText += `\n\nWorkspace statistics:`;
      responseText += `\n- Public channels: ${publicChannels.length}`;
      responseText += `\n- Private channels: ${privateChannels.length}`;
      responseText += `\n- Channels the bot is a member of: ${memberChannels.length}`;

      if (hasChannelRestrictions) {
        responseText += `\n\nNote: The bot is restricted to ${allowedChannelIds.length} specific channel(s).`;
      }

      return {
        data: {
          teamId,
          botUserId,
          workspaceName,
          domain,
          isConnected,
          publicChannelCount: publicChannels.length,
          privateChannelCount: privateChannels.length,
          memberChannelCount: memberChannels.length,
          hasChannelRestrictions,
          allowedChannelIds: allowedChannelIds.slice(0, 25),
        },
        values: {
          teamId: teamId || "",
          botUserId: botUserId || "",
          workspaceName,
          domain,
          isConnected,
          publicChannelCount: publicChannels.length,
          privateChannelCount: privateChannels.length,
          memberChannelCount: memberChannels.length,
        },
        text: responseText,
      };
    } catch (error) {
      return {
        data: {
          isConnected: false,
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          isConnected: false,
          slackWorkspaceAvailable: false,
        },
        text: "Slack workspace information unavailable.",
      };
    }
  },
};

export default workspaceInfoProvider;
