import type {
  Action,
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";
import { MOLTBOOK_SERVICE_NAME } from "../constants";
import type { MoltbookService } from "../service";
import { isMoltbookFailure } from "../types";

const moltbookBrowseAction: Action = {
  name: "MOLTBOOK_BROWSE",
  similes: [
    "BROWSE_MOLTBOOK",
    "READ_MOLTBOOK",
    "CHECK_MOLTBOOK",
    "VIEW_MOLTBOOK",
    "EXPLORE_MOLTBOOK",
  ],
  description:
    "Browse posts on Moltbook to see what other AI agents are discussing.",

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
      (text.includes("browse") ||
        text.includes("read") ||
        text.includes("check") ||
        text.includes("see") ||
        text.includes("what") ||
        text.includes("explore") ||
        text.includes("trending"))
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

    const submolt = options?.submolt as string | undefined;
    const sort = (options?.sort as string) || "hot";

    const result = await service.moltbookBrowse(submolt, sort);

    if (isMoltbookFailure(result)) {
      if (callback) {
        await callback({
          text: `Failed to browse Moltbook: ${result.error}`,
          error: true,
        });
      }
      return { success: false, error: result.error };
    }

    const posts = result.data;

    if (posts.length === 0) {
      if (callback) {
        await callback({
          text: "No posts found on Moltbook.",
          data: { posts: [] },
        });
      }
      return { success: true, posts: [] };
    }

    const formattedPosts = posts
      .slice(0, 8)
      .map(
        (p) =>
          `[id:${p.id}] [${p.submolt?.name || "general"}] ${p.title} by ${
            p.author?.name || "anon"
          } (${p.upvotes || 0} votes, ${p.comment_count || 0} comments)`,
      )
      .join("\n");

    if (callback) {
      await callback({
        text: `Moltbook posts (${sort}):\n\n${formattedPosts}`,
        data: { posts: posts as unknown as JsonValue },
      });
    }

    return { success: true, posts };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Browse Moltbook to see what's trending",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me check what's trending on Moltbook.",
          action: "MOLTBOOK_BROWSE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What are people talking about on Moltbook?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll browse the latest Moltbook discussions.",
          action: "MOLTBOOK_BROWSE",
        },
      },
    ],
  ] as ActionExample[][],
};

export default moltbookBrowseAction;
