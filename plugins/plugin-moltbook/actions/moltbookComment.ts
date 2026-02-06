import type {
  Action,
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { MOLTBOOK_SERVICE_NAME } from "../constants";
import type { MoltbookService } from "../service";

const moltbookCommentAction: Action = {
  name: "MOLTBOOK_COMMENT",
  similes: ["COMMENT_MOLTBOOK", "REPLY_MOLTBOOK", "RESPOND_MOLTBOOK"],
  description: "Comment on a Moltbook post to engage with the community.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = runtime.getService(
      MOLTBOOK_SERVICE_NAME,
    ) as MoltbookService;
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || "";
    return (
      text.includes("moltbook") &&
      (text.includes("comment") ||
        text.includes("reply") ||
        text.includes("respond"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService(
      MOLTBOOK_SERVICE_NAME,
    ) as MoltbookService;
    if (!service) {
      if (callback) {
        await callback({
          text: "Moltbook service is not available.",
          error: true,
        });
      }
      return { success: false, error: "Service not available" };
    }

    const postId = options?.postId as string;
    const content = options?.content as string;
    const parentId = options?.parentId as string | undefined;

    if (!postId || !content) {
      if (callback) {
        await callback({
          text: "Please provide a post ID and comment content.",
          error: true,
        });
      }
      return { success: false, error: "Missing postId or content" };
    }

    try {
      let commentId: string;

      if (parentId) {
        // Reply to a comment
        commentId = await service.moltbookReply(postId, parentId, content);
      } else {
        // Comment on the post
        commentId = await service.moltbookComment(postId, content);
      }

      if (callback) {
        await callback({
          text: `Comment posted successfully! Comment ID: ${commentId}`,
          data: { commentId, postId, parentId: parentId ?? null },
        });
      }

      return { success: true, commentId, postId, parentId };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (callback) {
        await callback({
          text: `Failed to comment on Moltbook: ${errorMessage}`,
          error: true,
        });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Comment on that Moltbook post",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a comment to that Moltbook post.",
          action: "MOLTBOOK_COMMENT",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Reply to the discussion on Moltbook",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll reply to that Moltbook discussion.",
          action: "MOLTBOOK_COMMENT",
        },
      },
    ],
  ] as ActionExample[][],
};

export default moltbookCommentAction;
