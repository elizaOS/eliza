import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

export const CHAT_STATE_PROVIDER = "msteams_chat_state";

/**
 * Provider that exposes MS Teams chat context including conversation ID,
 * user ID, conversation type, and tenant information.
 */
export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description:
    "Provides Microsoft Teams chat context including conversation ID, user ID, conversation type, and tenant information",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const conversationId = message.content?.conversationId as
      | string
      | undefined;
    const userId = message.content?.userId as string | undefined;
    const tenantId = message.content?.tenantId as string | undefined;
    const conversationType = message.content?.conversationType as
      | string
      | undefined;
    const activityId = message.content?.activityId as string | undefined;
    const roomId = message.roomId;

    const isPersonal = conversationType === "personal";
    const isGroupChat = conversationType === "groupChat";
    const isChannel = conversationType === "channel";

    const data = {
      conversationId,
      userId,
      tenantId,
      conversationType,
      activityId,
      roomId,
      isPersonal,
      isGroupChat,
      isChannel,
    };

    const values: Record<string, string> = {
      conversation_id: conversationId || "",
      user_id: userId || "",
      tenant_id: tenantId || "",
      conversation_type: conversationType || "",
      activity_id: activityId || "",
      room_id: roomId || "",
      is_personal: isPersonal.toString(),
      is_group_chat: isGroupChat.toString(),
      is_channel: isChannel.toString(),
    };

    let text = "Microsoft Teams Chat State:\n";
    if (conversationId) {
      text += `Conversation ID: ${conversationId}\n`;
    }
    if (conversationType) {
      text += `Conversation Type: ${conversationType}\n`;
    }
    if (userId) {
      text += `User ID: ${userId}\n`;
    }
    if (tenantId) {
      text += `Tenant ID: ${tenantId}\n`;
    }
    if (activityId) {
      text += `Activity ID: ${activityId}\n`;
    }

    return {
      data,
      values,
      text,
    };
  },
};

export const CONVERSATION_MEMBERS_PROVIDER = "msteams_conversation_members";

/**
 * Provider that exposes information about members in the current conversation.
 */
export const conversationMembersProvider: Provider = {
  name: CONVERSATION_MEMBERS_PROVIDER,
  description:
    "Provides information about members in the current Microsoft Teams conversation",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const members = message.content?.members as
      | Array<{
          id: string;
          name?: string;
          email?: string;
        }>
      | undefined;

    const memberCount = members?.length ?? 0;

    const data = {
      members: members ?? [],
      memberCount,
    };

    const values: Record<string, string> = {
      member_count: memberCount.toString(),
      member_names: members?.map((m) => m.name || m.id).join(", ") || "",
    };

    let text = "Microsoft Teams Conversation Members:\n";
    text += `Member Count: ${memberCount}\n`;
    if (members && members.length > 0) {
      text += "Members:\n";
      for (const member of members) {
        text += `- ${member.name || member.id}${member.email ? ` (${member.email})` : ""}\n`;
      }
    }

    return {
      data,
      values,
      text,
    };
  },
};

export const TEAM_INFO_PROVIDER = "msteams_team_info";

/**
 * Provider that exposes information about the current Teams team/channel.
 */
export const teamInfoProvider: Provider = {
  name: TEAM_INFO_PROVIDER,
  description:
    "Provides information about the current Microsoft Teams team and channel",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const teamId = message.content?.teamId as string | undefined;
    const teamName = message.content?.teamName as string | undefined;
    const channelId = message.content?.channelId as string | undefined;
    const channelName = message.content?.channelName as string | undefined;
    const isThread = Boolean(message.content?.threadId);

    const data = {
      teamId,
      teamName,
      channelId,
      channelName,
      isThread,
    };

    const values: Record<string, string> = {
      team_id: teamId || "",
      team_name: teamName || "",
      channel_id: channelId || "",
      channel_name: channelName || "",
      is_thread: isThread.toString(),
    };

    let text = "Microsoft Teams Team Info:\n";
    if (teamName || teamId) {
      text += `Team: ${teamName || teamId}\n`;
    }
    if (channelName || channelId) {
      text += `Channel: ${channelName || channelId}\n`;
    }
    if (isThread) {
      text += "Message is in a thread\n";
    }

    return {
      data,
      values,
      text,
    };
  },
};
