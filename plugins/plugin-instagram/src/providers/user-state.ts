/**
 * User state provider for Instagram
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

type InstagramUserState = {
  user_id: number | null;
  thread_id: string | null;
  media_id: number | null;
  room_id: string | null;
  is_dm: boolean;
  is_comment: boolean;
};

function formatInstagramUserStateForPrompt(stateData: InstagramUserState): string {
  return [
    "Instagram user state:",
    `user_id: ${formatPromptValue(stateData.user_id)}`,
    `thread_id: ${formatPromptValue(stateData.thread_id)}`,
    `media_id: ${formatPromptValue(stateData.media_id)}`,
    `room_id: ${formatPromptValue(stateData.room_id)}`,
    `is_dm: ${stateData.is_dm}`,
    `is_comment: ${stateData.is_comment}`,
  ].join("\n");
}

function formatPromptValue(value: string | number | null): string {
  return value === null ? "null" : String(value);
}

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
  descriptionCompressed:
    "provide Instagram user context state includ user ID, thread ID, interaction type",

  dynamic: true,
  contexts: ["social_posting", "messaging", "connectors"],
  contextGate: { anyOf: ["social_posting", "messaging", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  async get(_runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> {
    const content = message.content as Record<string, unknown>;

    // Extract Instagram context from the message
    const userId = content.userId as number | undefined;
    const threadId = content.threadId as string | undefined;
    const mediaId = content.mediaId as number | undefined;
    const roomId = message.roomId;

    const isDm = threadId !== undefined && threadId !== null;
    const isComment = mediaId !== undefined && mediaId !== null;

    const stateData: InstagramUserState = {
      user_id: userId ?? null,
      thread_id: threadId ?? null,
      media_id: mediaId ?? null,
      room_id: roomId ?? null,
      is_dm: isDm,
      is_comment: isComment,
    };

    return {
      text: formatInstagramUserStateForPrompt(stateData),
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
