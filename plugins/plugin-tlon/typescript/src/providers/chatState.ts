import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { TlonChannelType, type TlonContent } from "../types";

export const CHAT_STATE_PROVIDER = "tlon_chat_state";

/**
 * Provider that exposes the current Tlon chat context
 */
export const chatStateProvider: Provider = {
  name: CHAT_STATE_PROVIDER,
  description:
    "Provides Tlon/Urbit chat context including ship, channel, and message type",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const content = message.content as TlonContent;
    const ship = content?.ship;
    const channelNest = content?.channelNest;
    const replyToId = content?.replyToId;
    const roomId = message.roomId;

    // Determine chat type
    let chatType: TlonChannelType = TlonChannelType.DM;
    if (channelNest?.includes("/")) {
      chatType = replyToId ? TlonChannelType.THREAD : TlonChannelType.GROUP;
    }

    const isDm = chatType === TlonChannelType.DM;
    const isGroup = chatType === TlonChannelType.GROUP;
    const isThread = chatType === TlonChannelType.THREAD;

    const data = {
      ship,
      channelNest,
      replyToId,
      roomId,
      chatType,
      isDm,
      isGroup,
      isThread,
    };

    const values: Record<string, string> = {
      ship: ship || "",
      channel_nest: channelNest || "",
      reply_to_id: replyToId || "",
      room_id: roomId || "",
      chat_type: chatType,
      is_dm: isDm.toString(),
      is_group: isGroup.toString(),
      is_thread: isThread.toString(),
    };

    let text = "Tlon Chat State:\n";
    if (ship) {
      text += `Ship: ~${ship}\n`;
    }
    if (channelNest) {
      text += `Channel: ${channelNest}\n`;
    }
    text += `Chat Type: ${chatType}\n`;
    if (replyToId) {
      text += `Reply To: ${replyToId}\n`;
    }

    return {
      data,
      values,
      text,
    };
  },
};
