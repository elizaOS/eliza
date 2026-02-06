import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { NEXTCLOUD_TALK_SERVICE_NAME } from "../constants";
import type { NextcloudTalkService } from "../service";

export const CHAT_STATE_PROVIDER = "nextcloud_talk_chat_state";

export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description:
    "Provides Nextcloud Talk chat context including room token, sender ID, and room type",
  dynamic: true,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const roomToken = message.content?.roomToken as string | undefined;
    const senderId = message.content?.senderId as string | undefined;
    const roomId = message.roomId;

    const service = runtime.getService(NEXTCLOUD_TALK_SERVICE_NAME) as
      | NextcloudTalkService
      | undefined;
    const room = roomToken ? service?.getRoom(roomToken) : undefined;

    const isGroupChat = room?.type === "group" || room?.type === "public";
    const isPrivate = room?.type === "one-to-one";

    const data = {
      roomToken,
      senderId,
      roomId,
      roomName: room?.displayName || room?.name,
      roomType: room?.type,
      isGroupChat,
      isPrivate,
      baseUrl: service?.baseUrl,
    };

    const values: Record<string, string> = {
      room_token: roomToken || "",
      sender_id: senderId || "",
      room_id: roomId || "",
      room_name: room?.displayName || room?.name || "",
      room_type: room?.type || "",
      is_group_chat: isGroupChat.toString(),
      is_private: isPrivate.toString(),
      base_url: service?.baseUrl || "",
    };

    let text = "Nextcloud Talk Chat State:\n";
    if (roomToken) {
      text += `Room Token: ${roomToken}\n`;
      text += `Room Name: ${room?.displayName || room?.name || "Unknown"}\n`;
      text += `Room Type: ${isPrivate ? "Private (1:1)" : isGroupChat ? "Group" : "Unknown"}\n`;
    }
    if (senderId) {
      text += `Sender ID: ${senderId}\n`;
    }
    if (service?.baseUrl) {
      text += `Nextcloud URL: ${service.baseUrl}\n`;
    }

    return {
      data,
      values,
      text,
    };
  },
};
