/**
 * Browse Action
 *
 * Browse the Moltbook feed and display posts.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { PLUGIN_NAME } from "../constants";
import type { MoltbookService } from "../service";

export const browseAction: Action = {
  name: "MOLTBOOK_BROWSE",
  similes: [
    "BROWSE_MOLTBOOK",
    "VIEW_MOLTBOOK_FEED",
    "MOLTBOOK_FEED",
    "CHECK_MOLTBOOK",
    "WHATS_ON_MOLTBOOK",
  ],
  description: "Browse the Moltbook feed to see recent posts.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "browse"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|browse)\b/i;
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
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined
    ): Promise<boolean> => {
      const text = message.content.text?.toLowerCase() || "";

      // Check for browse intent
      const hasBrowseIntent =
        text.includes("browse") ||
        text.includes("feed") ||
        text.includes("check") ||
        text.includes("what's on") ||
        text.includes("whats on") ||
        text.includes("show me") ||
        text.includes("look at");

      const hasMoltbookMention = text.includes("moltbook");

      return hasBrowseIntent && hasMoltbookMention;
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
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
    if (!service) {
      const error = "Moltbook service is not available";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    // Check authentication
    const creds = await service.getCredentials();
    if (!creds) {
      const error = "Not authenticated with Moltbook.";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    try {
      // Get feed
      const feed = await service.getFeed({ forceFresh: true });

      if (!feed || feed.posts.length === 0) {
        if (callback) {
          await callback({
            text: "No posts found in the feed right now.",
          });
        }
        return {
          success: true,
          text: "No posts in feed",
          values: { postCount: 0 },
          data: { action: "MOLTBOOK_BROWSE", posts: [] },
        };
      }

      // Format posts for display (inlined formatPostSummary + getRelativeTime)
      const displayPosts = feed.posts.slice(0, 5);
      const formattedPosts = displayPosts
        .map((post) => {
          const now = new Date();
          const diffMs = now.getTime() - new Date(post.createdAt).getTime();
          const diffMins = Math.floor(diffMs / 60000);
          const diffHours = Math.floor(diffMins / 60);
          const diffDays = Math.floor(diffHours / 24);

          let timeAgo: string;
          if (diffMins < 1) timeAgo = "just now";
          else if (diffMins < 60) timeAgo = `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
          else if (diffHours < 24) timeAgo = `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
          else if (diffDays < 7) timeAgo = `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
          else timeAgo = new Date(post.createdAt).toLocaleDateString();

          const score = post.score >= 0 ? `↑${post.score}` : `↓${Math.abs(post.score)}`;
          return `**${post.title}** by @${post.author.username}\n${score} 💬${post.commentCount} • ${timeAgo}\n${post.content.slice(0, 150)}${post.content.length > 150 ? "..." : ""}`;
        })
        .join("\n\n---\n\n");

      if (callback) {
        await callback({
          text: `**Moltbook Feed** (${feed.posts.length} posts)\n\n${formattedPosts}`,
        });
      }

      return {
        success: true,
        text: `Showing ${displayPosts.length} posts from Moltbook`,
        values: {
          postCount: feed.posts.length,
          displayedCount: displayPosts.length,
        },
        data: {
          action: "MOLTBOOK_BROWSE",
          posts: displayPosts,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error({ error }, "Error browsing Moltbook");

      if (callback) {
        await callback({
          text: `Failed to browse: ${errorMessage}`,
          error: true,
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
      };
    }
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: {
          text: "What's on Moltbook?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Moltbook Feed** (12 posts)\n\n**Thoughts on AI Agents** by @alice\n↑15 💬8 • 2 hours ago\n\n---\n\n**New framework release** by @bob\n↑23 💬12 • 4 hours ago",
          actions: ["MOLTBOOK_BROWSE"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Browse the Moltbook feed",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Moltbook Feed** (8 posts)\n\n**Question about memory systems** by @charlie\n↑7 💬3 • 1 hour ago",
          actions: ["MOLTBOOK_BROWSE"],
        },
      },
    ],
  ],
};

export default browseAction;
