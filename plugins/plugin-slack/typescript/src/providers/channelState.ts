import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { SlackService } from "../service";
import { getSlackChannelType, ServiceType } from "../types";

/**
 * Provider for retrieving Slack channel state information.
 */
export const channelStateProvider: Provider = {
  name: "slackChannelState",
  description: "Provides information about the current Slack channel context",
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    // If message source is not slack, return empty
    if (message.content.source !== "slack") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";
    const senderName = state?.senderName || "someone";

    let responseText = "";
    let channelType = "";
    let workspaceName = "";
    let channelName = "";
    const channelId = room.channelId ?? "";
    const threadTs = room.metadata?.threadTs as string | undefined;

    const slackService = await runtime.getService(ServiceType.SLACK) as SlackService;
    if (!slackService || !slackService.client) {
      runtime.logger.warn(
        {
          src: "plugin:slack:provider:channelState",
          agentId: runtime.agentId,
          channelId,
        },
        "No Slack client found",
      );
      return {
        data: {
          room,
          channelType: "unknown",
          channelId,
        },
        values: {
          channelType: "unknown",
          channelId,
        },
        text: "",
      };
    }

    // Get channel info
    const channel = channelId ? await slackService.getChannel(channelId) : null;
    if (channel) {
      channelName = channel.name;
      const slackChannelType = getSlackChannelType(channel);

      if (slackChannelType === "im") {
        channelType = "DM";
        responseText = `${agentName} is currently in a direct message conversation with ${senderName} on Slack. ${agentName} should engage in conversation, responding to messages that are addressed to them.`;
      } else if (slackChannelType === "mpim") {
        channelType = "GROUP_DM";
        responseText = `${agentName} is currently in a group direct message on Slack. ${agentName} should be aware that multiple people can see this conversation.`;
      } else {
        channelType =
          slackChannelType === "group" ? "PRIVATE_CHANNEL" : "PUBLIC_CHANNEL";

        if (threadTs) {
          responseText = `${agentName} is currently in a thread within the channel #${channelName} on Slack.`;
          responseText += `\n${agentName} should keep responses focused on the thread topic and be mindful of thread etiquette.`;
        } else {
          responseText = `${agentName} is currently having a conversation in the Slack channel #${channelName}.`;
          responseText += `\n${agentName} is in a channel with other users and should only participate when directly addressed or when the conversation is relevant to them.`;
        }

        if (channel.topic?.value) {
          responseText += `\nChannel topic: ${channel.topic.value}`;
        }
        if (channel.purpose?.value) {
          responseText += `\nChannel purpose: ${channel.purpose.value}`;
        }
      }
    } else {
      channelType = "unknown";
      responseText = `${agentName} is in a Slack conversation but couldn't retrieve channel details.`;
    }

    // Add workspace context if available
    const teamId = slackService.getTeamId();
    if (teamId && room.worldId) {
      const world = await runtime.getWorld(room.worldId);
      if (world) {
        workspaceName = world.name;
        responseText += `\nWorkspace: ${workspaceName}`;
      }
    }

    // Add thread context if applicable
    if (threadTs) {
      responseText += `\nThis is a threaded conversation (thread timestamp: ${threadTs}).`;
    }

    return {
      data: {
        room,
        channelType,
        workspaceName,
        channelName,
        channelId,
        threadTs,
        isThread: Boolean(threadTs),
        topic: channel?.topic?.value,
        purpose: channel?.purpose?.value,
        isPrivate: channel?.isPrivate,
        numMembers: channel?.numMembers,
      },
      values: {
        channelType,
        workspaceName,
        channelName,
        channelId,
        isThread: Boolean(threadTs),
      },
      text: responseText,
    };
  },
};

export default channelStateProvider;
