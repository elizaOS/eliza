/**
 * Post comment action for Instagram
 */

import type {
  Action,
  ActionExample,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME } from "../constants";
import type { InstagramService } from "../service";

/**
 * Action to post a comment on Instagram media
 */
export const postCommentAction: Action = {
  name: "POST_INSTAGRAM_COMMENT",
  description: "Post a comment on an Instagram post or media",
  similes: [
    "instagram_comment",
    "comment_instagram",
    "reply_instagram",
    "post_comment_instagram",
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Comment on this Instagram post",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll post a comment on that Instagram post.",
          action: "POST_INSTAGRAM_COMMENT",
        },
      },
    ],
  ] as ActionExample[][],

  async validate(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> {
    // Check if this is an Instagram context with a media ID
    const content = message.content as Record<string, unknown>;
    const source = content.source as string | undefined;
    const mediaId = content.mediaId as number | undefined;

    if (source !== "instagram") {
      return false;
    }

    if (!mediaId) {
      return false;
    }

    // Check if Instagram service is available
    const service = runtime.getService(INSTAGRAM_SERVICE_NAME);
    if (!service) {
      return false;
    }

    return true;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ) {
    const service = runtime.getService(
      INSTAGRAM_SERVICE_NAME,
    ) as InstagramService;
    if (!service || !service.getIsRunning()) {
      if (callback) {
        await callback({
          text: "Instagram service is not running",
        });
      }
      return { success: false, error: "Service not available" };
    }

    const content = message.content as Record<string, unknown>;
    const mediaId = content.mediaId as number | undefined;

    if (!mediaId) {
      if (callback) {
        await callback({
          text: "No media ID provided for Instagram comment",
        });
      }
      return { success: false, error: "Missing media ID" };
    }

    // Get response text from state or message
    const responseText =
      ((state?.response as Record<string, unknown> | undefined)?.text as
        | string
        | undefined) ||
      (content.text as string | undefined) ||
      "";

    if (!responseText) {
      if (callback) {
        await callback({
          text: "No comment text to post",
        });
      }
      return { success: false, error: "Empty comment" };
    }

    try {
      const commentId = await service.postComment(mediaId, responseText);

      if (callback) {
        await callback({
          text: `Comment posted on Instagram media ${mediaId}`,
          action: "POST_INSTAGRAM_COMMENT",
        });
      }

      return { success: true, data: { mediaId, commentId } };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({
          text: `Failed to post Instagram comment: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },
};
