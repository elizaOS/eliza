import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME } from "./constants";
import type { InstagramService } from "./service";

/**
 * Provider for Instagram user state information
 */
export const userStateProvider: Provider = {
  name: "instagram_user_state",
  description: "Provides Instagram user and conversation state",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<InstagramService>(
      INSTAGRAM_SERVICE_NAME,
    );

    if (!service) {
      return { text: "Instagram service is not available." };
    }

    if (!service.getIsRunning()) {
      return { text: "Instagram service is not running." };
    }

    const loggedInUser = service.getLoggedInUser();
    if (!loggedInUser) {
      return { text: "Not logged in to Instagram." };
    }

    // Build context string
    const parts: string[] = [`Logged in as: @${loggedInUser.username}`];

    if (loggedInUser.fullName) {
      parts.push(`Display name: ${loggedInUser.fullName}`);
    }

    if (loggedInUser.followerCount !== undefined) {
      parts.push(`Followers: ${loggedInUser.followerCount}`);
    }

    if (loggedInUser.followingCount !== undefined) {
      parts.push(`Following: ${loggedInUser.followingCount}`);
    }

    // Add conversation context if available
    const threadId = state?.threadId as string | undefined;
    const userId = state?.userId as number | undefined;
    const mediaId = state?.mediaId as number | undefined;

    if (threadId) {
      parts.push(`Current thread: ${threadId}`);
    }

    if (userId) {
      parts.push(`Current user ID: ${userId}`);
    }

    if (mediaId) {
      parts.push(`Current media ID: ${mediaId}`);
    }

    return {
      text: parts.join("\n"),
      values: {
        instagramUsername: loggedInUser.username,
        instagramUserId: loggedInUser.pk,
        isRunning: true,
      },
      data: {
        loggedInUser,
        threadId,
        userId,
        mediaId,
      },
    };
  },
};
