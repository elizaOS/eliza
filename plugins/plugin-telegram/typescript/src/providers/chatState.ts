import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

export const CHAT_STATE_PROVIDER = "telegram_chat_state";

export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description: "Provides Telegram chat context including chat ID, user ID, and chat type",
  dynamic: true,

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const chatId = message.content?.chatId as number | undefined;
    const userId = message.content?.userId as number | undefined;
    const threadId = message.content?.threadId as number | undefined;
    const roomId = message.roomId;

    const isPrivate = chatId !== undefined && chatId > 0;
    const isGroup = chatId !== undefined && chatId < 0;

    const data = {
      chatId,
      userId,
      threadId,
      roomId,
      isPrivate,
      isGroup,
    };

    const values: Record<string, string> = {
      chat_id: chatId?.toString() || "",
      user_id: userId?.toString() || "",
      thread_id: threadId?.toString() || "",
      room_id: roomId || "",
      is_private: isPrivate.toString(),
      is_group: isGroup.toString(),
    };

    let text = "Telegram Chat State:\n";
    if (chatId) {
      text += `Chat ID: ${chatId}\n`;
      text += `Chat Type: ${isPrivate ? "Private" : "Group"}\n`;
    }
    if (userId) {
      text += `User ID: ${userId}\n`;
    }
    if (threadId) {
      text += `Thread ID: ${threadId}\n`;
    }

    return {
      data,
      values,
      text,
    };
  },
};
