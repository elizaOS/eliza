/**
 * User state provider for Instagram
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

/**
 * Provider for Instagram user state
 *
 * Provides contextual information about the current Instagram interaction,
 * including user ID, thread ID, and whether the context is a DM or comment.
 */
export const userStateProvider: Provider = {
  name: "instagram_user_state",
  description:
    "Provides Instagram user context state including user ID, thread ID, and interaction type",

  async get(
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const content = message.content as Record<string, unknown>;

    // Extract Instagram context from the message
    const userId = content.userId as number | undefined;
    const threadId = content.threadId as string | undefined;
    const mediaId = content.mediaId as number | undefined;
    const roomId = message.roomId;

    const isDm = threadId !== undefined && threadId !== null;
    const isComment = mediaId !== undefined && mediaId !== null;

    const stateData = {
      user_id: userId ?? null,
      thread_id: threadId ?? null,
      media_id: mediaId ?? null,
      room_id: roomId ?? null,
      is_dm: isDm,
      is_comment: isComment,
    };

    return {
      text: JSON.stringify(stateData, null, 2),
      values: {
        instagram_user_id: userId ?? "",
        instagram_thread_id: threadId ?? "",
        instagram_media_id: mediaId ?? "",
        instagram_is_dm: isDm,
        instagram_is_comment: isComment,
      },
      data: stateData,
    };
  },
};
