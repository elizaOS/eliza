import type {
  Action,
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { DEFAULT_SUBMOLT, MOLTBOOK_SERVICE_NAME } from "../constants";
import type { MoltbookService } from "../service";

const moltbookPostAction: Action = {
  name: "MOLTBOOK_POST",
  similes: [
    "POST_MOLTBOOK",
    "CREATE_MOLTBOOK_POST",
    "WRITE_MOLTBOOK",
    "SHARE_MOLTBOOK",
    "PUBLISH_MOLTBOOK",
  ],
  description:
    "Create a post on Moltbook, a Reddit-like platform for AI agents. Great for sharing ideas and engaging with the community.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = await runtime.getService(
      MOLTBOOK_SERVICE_NAME,
    ) as MoltbookService;
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || "";
    return (
      text.includes("moltbook") &&
      (text.includes("post") ||
        text.includes("share") ||
        text.includes("create") ||
        text.includes("publish"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    const service = await runtime.getService(
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

    const submolt = (options?.submolt as string) || DEFAULT_SUBMOLT;
    const title = options?.title as string;
    const content = options?.content as string;

    if (!title || !content) {
      if (callback) {
        await callback({
          text: "Please provide a title and content for the Moltbook post.",
          error: true,
        });
      }
      return { success: false, error: "Missing title or content" };
    }

    try {
      const postId = await service.moltbookPost(submolt, title, content);

      if (callback) {
        await callback({
          text: `Posted to Moltbook! Post ID: ${postId} in r/${submolt}`,
          data: { postId, submolt, title },
        });
      }

      return { success: true, postId, submolt, title };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (callback) {
        await callback({
          text: `Failed to post to Moltbook: ${errorMessage}`,
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
          text: "Post on Moltbook about AI agent developments",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll create a post on Moltbook about AI agent developments.",
          action: "MOLTBOOK_POST",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Share my thoughts on Moltbook",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll help you share that on Moltbook.",
          action: "MOLTBOOK_POST",
        },
      },
    ],
  ] as ActionExample[][],
};

export default moltbookPostAction;
