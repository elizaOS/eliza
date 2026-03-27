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

const moltbookSubmoltsAction: Action = {
  name: "MOLTBOOK_SUBMOLTS",
  similes: [
    "LIST_SUBMOLTS",
    "SHOW_SUBMOLTS",
    "MOLTBOOK_COMMUNITIES",
    "EXPLORE_SUBMOLTS",
    "GET_SUBMOLT",
    "EXAMINE_SUBMOLT",
  ],
  description:
    "List available submolts (communities) on Moltbook or get details about a specific submolt.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "submolts"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|submolts)\b/i;
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
        (text.includes("moltbook") || text.includes("submolt")) &&
        (text.includes("list") ||
          text.includes("submolt") ||
          text.includes("communities") ||
          text.includes("subreddit") ||
          text.includes("explore") ||
          text.includes("examine") ||
          text.includes("what") ||
          text.includes("show"))
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

    const submoltName = options?.submolt as string | undefined;

    // If a specific submolt is requested, get its details
    if (submoltName) {
      // Get submolt directly (inlined wrapper)
      const submolt = await service.getSubmolt(submoltName);
      if (!submolt) {
        if (callback) {
          await callback({
            text: `Submolt "m/${submoltName}" not found.`,
            error: true,
          });
        }
        return { success: false, error: "Submolt not found" };
      }

      // Also get recent posts from this submolt (inlined wrapper)
      const feed = await service.getPosts({ submolt: submoltName, sort: "hot", limit: 10 });
      const posts = feed ? feed.posts : [];
      const recentPosts = posts
        .slice(0, 5)
        .map(
          (p) =>
            `  • ${p.title} by ${(p as any).author?.username || (p as any).author?.name || "anon"} (${p.upvotes || 0} votes)`
        )
        .join("\n");

      const submoltInfo = `
**m/${submolt.name}**
${submolt.description || "(no description)"}

Subscribers: ${(submolt as any).subscriber_count || (submolt as any).memberCount || "unknown"}
Posts: ${(submolt as any).post_count || (submolt as any).postCount || "unknown"}
${(submolt as any).created_at || (submolt as any).createdAt ? `Created: ${new Date((submolt as any).created_at || (submolt as any).createdAt).toLocaleDateString()}` : ""}

Recent posts:
${recentPosts || "  (no recent posts)"}
      `.trim();

      if (callback) {
        await callback({
          text: submoltInfo,
          data: {},
        });
      }

      return { success: true, submolt, posts };
    }

    // Otherwise, list all submolts (inlined wrapper)
    const submolts = await service.getSubmolts("popular");

    if (!submolts) {
      if (callback) {
        await callback({
          text: "Failed to get submolts",
          error: true,
        });
      }
      return { success: false, error: "Failed to get submolts" };
    }

    if (submolts.length === 0) {
      if (callback) {
        await callback({
          text: "No submolts found on Moltbook.",
          data: { submolts: [] },
        });
      }
      return { success: true, submolts: [] };
    }

    const formattedSubmolts = submolts
      .slice(0, 15)
      .map(
        (s) =>
          `• m/${s.name} - ${s.description?.slice(0, 60) || "(no description)"}${s.description && s.description.length > 60 ? "..." : ""} (${(s as any).memberCount || (s as any).subscriber_count || 0} members)`
      )
      .join("\n");

    if (callback) {
      await callback({
        text: `Available submolts on Moltbook:\n\n${formattedSubmolts}\n\nUse "examine m/[name]" to see details about a specific submolt.`,
        data: { submolts: submolts as any },
      });
    }

    return { success: true, submolts };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "List the submolts on Moltbook",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me show you the available submolts on Moltbook.",
          action: "MOLTBOOK_SUBMOLTS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What communities are there on Moltbook?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list the available communities for you.",
          action: "MOLTBOOK_SUBMOLTS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Examine the m/iq submolt",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me get the details about that submolt.",
          action: "MOLTBOOK_SUBMOLTS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me what m/crypto is about",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll examine that submolt for you.",
          action: "MOLTBOOK_SUBMOLTS",
        },
      },
    ],
  ] as ActionExample[][],
};

export default moltbookSubmoltsAction;
