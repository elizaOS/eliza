import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { getChannelKind } from "../types";

export const CHAT_STATE_PROVIDER = "mattermost_chat_state";

export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description:
    "Provides Mattermost chat context including channel ID, user ID, team ID, and channel type",
  dynamic: true,

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const channelId = message.content?.channelId as string | undefined;
    const userId = message.content?.userId as string | undefined;
    const metadata = message.content?.metadata as Record<string, unknown> | undefined;
    const postId = metadata?.postId as string | undefined;
    const rootId = metadata?.rootId as string | undefined;
    const teamId = metadata?.teamId as string | undefined;
    const channelType = metadata?.channelType as string | undefined;
    const roomId = message.roomId;

    const kind = getChannelKind(channelType);
    const isDm = kind === "dm";
    const isGroup = kind === "group";
    const isChannel = kind === "channel";
    const isThread = Boolean(rootId);

    const data = {
      channelId,
      userId,
      postId,
      rootId,
      teamId,
      channelType,
      roomId,
      isDm,
      isGroup,
      isChannel,
      isThread,
    };

    const values: Record<string, string> = {
      channel_id: channelId || "",
      user_id: userId || "",
      post_id: postId || "",
      root_id: rootId || "",
      team_id: teamId || "",
      channel_type: channelType || "",
      room_id: roomId || "",
      is_dm: isDm.toString(),
      is_group: isGroup.toString(),
      is_channel: isChannel.toString(),
      is_thread: isThread.toString(),
    };

    let text = "Mattermost Chat State:\n";
    if (channelId) {
      text += `Channel ID: ${channelId}\n`;
    }
    if (channelType) {
      const typeLabel = isDm ? "Direct Message" : isGroup ? "Group Message" : "Channel";
      text += `Channel Type: ${typeLabel}\n`;
    }
    if (userId) {
      text += `User ID: ${userId}\n`;
    }
    if (teamId) {
      text += `Team ID: ${teamId}\n`;
    }
    if (rootId) {
      text += `Thread Root: ${rootId}\n`;
    }

    return {
      data,
      values,
      text,
    };
  },
};
