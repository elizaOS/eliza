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

const moltbookReadAction: Action = {
  name: "MOLTBOOK_READ",
  similes: ["READ_MOLTBOOK_POST", "VIEW_MOLTBOOK_POST", "GET_MOLTBOOK_POST", "OPEN_MOLTBOOK_POST"],
  description: "Read a specific Moltbook post with its comments to see the full discussion.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "read"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|read)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State
    ): Promise<boolean> => {
      const service = runtime.getService(MOLTBOOK_SERVICE_NAME) as MoltbookService;
      if (!service) {
        return false;
      }

      const text = message.content?.text?.toLowerCase() || "";
      return (
        text.includes("moltbook") &&
        (text.includes("read post") ||
          text.includes("view post") ||
          text.includes("open post") ||
          text.includes("show post") ||
          text.includes("get post"))
      );
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const service = runtime.getService(MOLTBOOK_SERVICE_NAME) as MoltbookService;
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

    if (!postId) {
      if (callback) {
        await callback({
          text: "Please provide a post ID to read.",
          error: true,
        });
      }
      return { success: false, error: "Missing postId" };
    }

    try {
      // Get post and comments directly (inlined wrapper)
      const post = await service.getPost(postId);
      if (!post) {
        throw new Error("Post not found");
      }
      const comments = await service.getComments(postId);

      const formattedComments =
        comments.length > 0
          ? comments
              .slice(0, 10)
              .map(
                (c) =>
                  `  - ${(c as any).author?.username || (c as any).author?.name || "anon"}: ${c.content.slice(0, 200)}${c.content.length > 200 ? "..." : ""}`
              )
              .join("\n")
          : "  (no comments yet)";

      const postContent = post.content || (post as any).body || "(no content)";
      const truncatedContent =
        postContent.length > 500 ? `${postContent.slice(0, 500)}...` : postContent;

      const formattedPost = `
**${post.title}**
by ${(post as any).author?.username || (post as any).author?.name || "anon"} in r/${typeof (post as any).submolt === "string" ? (post as any).submolt : (post as any).submolt?.name || "general"}
${post.upvotes || 0} upvotes | ${(post as any).commentCount || (post as any).comment_count || 0} comments

${truncatedContent}

Comments:
${formattedComments}
      `.trim();

      if (callback) {
        await callback({
          text: formattedPost,
          data: {},
        });
      }

      return { success: true, post, comments };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (callback) {
        await callback({
          text: `Failed to read Moltbook post: ${errorMessage}`,
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
          text: "Read Moltbook post abc123",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me fetch that Moltbook post for you.",
          action: "MOLTBOOK_READ",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the Moltbook post with ID xyz789",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll retrieve that post from Moltbook.",
          action: "MOLTBOOK_READ",
        },
      },
    ],
  ] as ActionExample[][],
};

export default moltbookReadAction;
