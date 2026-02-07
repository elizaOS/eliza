import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

export const CHAT_STATE_PROVIDER = "zalo_chat_state";

export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description: "Provides Zalo chat context including user ID and chat metadata",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const userId = message.content?.userId as string | undefined;
    const chatId = message.content?.chatId as string | undefined;
    const roomId = message.roomId;

    // Zalo OA only supports private chats
    const isPrivate = true;

    const data = {
      userId,
      chatId: chatId || userId,
      roomId,
      isPrivate,
      platform: "zalo",
    };

    const values: Record<string, string> = {
      user_id: userId || "",
      chat_id: chatId || userId || "",
      room_id: roomId || "",
      is_private: "true",
      platform: "zalo",
    };

    let text = "Zalo Chat State:\n";
    if (userId) {
      text += `User ID: ${userId}\n`;
    }
    text += "Chat Type: Private (DM)\n";
    text += "Platform: Zalo Official Account\n";

    return {
      data,
      values,
      text,
    };
  },
};
