import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME } from "./constants";
import type { InstagramService } from "./service";

/**
 * Action to send a direct message on Instagram
 */
export const sendDmAction: Action = {
  name: "SEND_INSTAGRAM_DM",
  description: "Send a direct message to an Instagram user",
  similes: [
    "INSTAGRAM_DM",
    "INSTAGRAM_MESSAGE",
    "DM_USER",
    "SEND_DM",
    "DIRECT_MESSAGE",
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a DM to @friend saying hello",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a direct message to @friend",
          action: "SEND_INSTAGRAM_DM",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Check if Instagram service is available
    const service = runtime.getService<InstagramService>(
      INSTAGRAM_SERVICE_NAME,
    );
    if (!service) {
      return false;
    }

    // Check if this is related to Instagram messaging
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      text.includes("instagram") ||
      text.includes("dm") ||
      text.includes("direct message")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<InstagramService>(
      INSTAGRAM_SERVICE_NAME,
    );
    if (!service) {
      if (callback) {
        await callback({
          text: "Instagram service is not available.",
        });
      }
      return { success: false, error: "Instagram service is not available" };
    }

    // Extract thread ID and message from state or message
    const threadId = (state?.threadId as string) ?? "";
    const responseText =
      (state?.responseText as string) ?? message.content?.text ?? "";

    if (!threadId) {
      if (callback) {
        await callback({
          text: "No thread ID specified for Instagram DM.",
        });
      }
      return { success: false, error: "No thread ID specified" };
    }

    try {
      const messageId = await service.sendDirectMessage(threadId, responseText);
      if (callback) {
        await callback({
          text: `Message sent successfully (ID: ${messageId})`,
        });
      }
      return { success: true, text: `Message sent (ID: ${messageId})` };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({
          text: `Failed to send Instagram DM: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },
};

/**
 * Action to post a comment on Instagram media
 */
export const postCommentAction: Action = {
  name: "POST_INSTAGRAM_COMMENT",
  description: "Post a comment on an Instagram post",
  similes: ["INSTAGRAM_COMMENT", "COMMENT_POST", "REPLY_POST", "ADD_COMMENT"],
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Comment 'Great photo!' on that Instagram post",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll post that comment on the Instagram post",
          action: "POST_INSTAGRAM_COMMENT",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Check if Instagram service is available
    const service = runtime.getService<InstagramService>(
      INSTAGRAM_SERVICE_NAME,
    );
    if (!service) {
      return false;
    }

    // Check if this is related to Instagram commenting
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      text.includes("instagram") &&
      (text.includes("comment") || text.includes("reply"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<InstagramService>(
      INSTAGRAM_SERVICE_NAME,
    );
    if (!service) {
      if (callback) {
        await callback({
          text: "Instagram service is not available.",
        });
      }
      return { success: false, error: "Instagram service is not available" };
    }

    // Extract media ID and comment from state or message
    const mediaId = state?.mediaId as number | undefined;
    const commentText =
      (state?.commentText as string) ?? message.content?.text ?? "";

    if (!mediaId) {
      if (callback) {
        await callback({
          text: "No media ID specified for Instagram comment.",
        });
      }
      return { success: false, error: "No media ID specified" };
    }

    try {
      const commentId = await service.postComment(mediaId, commentText);
      if (callback) {
        await callback({
          text: `Comment posted successfully (ID: ${commentId})`,
        });
      }
      return { success: true, text: `Comment posted (ID: ${commentId})` };
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
