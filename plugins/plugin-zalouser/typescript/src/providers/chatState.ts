import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

export const CHAT_STATE_PROVIDER = "zalouser_chat_state";

export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description:
    "Provides Zalo User chat context including thread ID, user ID, and chat type",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const threadId = message.content?.threadId as string | undefined;
    const userId = message.content?.userId as string | undefined;
    const senderId = message.content?.senderId as string | undefined;
    const roomId = message.roomId;

    const isGroup = message.content?.isGroup as boolean | undefined;
    const isPrivate = isGroup === false;

    const data = {
      threadId,
      userId,
      senderId,
      roomId,
      isPrivate,
      isGroup,
    };

    const values: Record<string, string> = {
      thread_id: threadId || "",
      user_id: userId || "",
      sender_id: senderId || "",
      room_id: roomId || "",
      is_private: String(isPrivate ?? false),
      is_group: String(isGroup ?? false),
    };

    let text = "Zalo User Chat State:\n";
    if (threadId) {
      text += `Thread ID: ${threadId}\n`;
      text += `Chat Type: ${isGroup ? "Group" : "Private"}\n`;
    }
    if (userId) {
      text += `User ID: ${userId}\n`;
    }
    if (senderId) {
      text += `Sender ID: ${senderId}\n`;
    }

    return {
      data,
      values,
      text,
    };
  },
};
