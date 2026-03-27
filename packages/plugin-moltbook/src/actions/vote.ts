/**
 * Vote Action
 *
 * Upvote or downvote posts and comments on Moltbook.
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

export const voteAction: Action = {
  name: "MOLTBOOK_VOTE",
  similes: [
    "UPVOTE_MOLTBOOK",
    "DOWNVOTE_MOLTBOOK",
    "MOLTBOOK_UPVOTE",
    "MOLTBOOK_DOWNVOTE",
    "LIKE_MOLTBOOK",
  ],
  description: "Vote on a Moltbook post or comment (upvote, downvote, or remove vote).",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "vote"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|vote)\b/i;
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

      // Check for voting intent
      const hasVoteIntent =
        text.includes("upvote") ||
        text.includes("downvote") ||
        text.includes("vote") ||
        text.includes("like");

      const hasMoltbookMention =
        text.includes("moltbook") || text.includes("post") || text.includes("comment");

      return hasVoteIntent && hasMoltbookMention;
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
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

    // Check if account is claimed (required to vote)
    if (creds.claimStatus !== "claimed") {
      const claimUrl = creds.claimUrl || "https://moltbook.com";
      const error = `Cannot vote - account not yet claimed by human. Claim URL: ${claimUrl}`;
      if (callback) {
        await callback({
          text: `I can't vote on Moltbook yet - my account needs to be claimed by a human first. Please visit: ${claimUrl}`,
          error: true,
        });
      }
      runtime.logger.warn({ claimUrl }, "Moltbook: Attempted to vote but account not claimed");
      return { success: false, error: new Error(error) };
    }

    // Extract intent
    const intent = extractVoteIntent(message.content.text || "");

    if (!intent.postId) {
      const error = "Please specify which post to vote on (by ID).";
      if (callback) {
        await callback({ text: error });
      }
      return { success: false, error: new Error(error) };
    }

    try {
      let success: boolean;
      let description: string;

      if (intent.commentId) {
        // Vote on comment (Moltbook API uses only commentId)
        success = await service.voteComment(intent.commentId, intent.direction);
        description = `${intent.direction === "up" ? "Upvoted" : "Downvoted"} comment`;
      } else {
        // Vote on post
        success = await service.votePost(intent.postId!, intent.direction);
        description = `${intent.direction === "up" ? "Upvoted" : "Downvoted"} post`;
      }

      if (!success) {
        const error = "Failed to register vote.";
        if (callback) {
          await callback({ text: error, error: true });
        }
        return { success: false, error: new Error(error) };
      }

      // Success response
      if (callback) {
        const emoji = intent.direction === "up" ? "👍" : "👎";
        await callback({
          text: `${emoji} ${description}`,
        });
      }

      return {
        success: true,
        text: description,
        values: {
          postId: intent.postId,
          commentId: intent.commentId,
          direction: intent.direction,
        },
        data: {
          action: "MOLTBOOK_VOTE",
          postId: intent.postId,
          commentId: intent.commentId,
          direction: intent.direction,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error({ error }, "Error voting on Moltbook");

      if (callback) {
        await callback({
          text: `Failed to vote: ${errorMessage}`,
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
          text: "Upvote post abc123 on Moltbook",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "👍 Upvoted post",
          actions: ["MOLTBOOK_VOTE"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Downvote that Moltbook comment xyz789",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "👎 Downvoted comment",
          actions: ["MOLTBOOK_VOTE"],
        },
      },
    ],
  ],
};

/**
 * Extract vote intent from user message
 * Note: Moltbook API only supports upvote/downvote, not vote removal
 */
function extractVoteIntent(text: string): {
  postId?: string;
  commentId?: string;
  direction: "up" | "down";
} {
  const lowerText = text.toLowerCase();

  // Determine direction (default to upvote)
  const direction: "up" | "down" =
    lowerText.includes("downvote") || lowerText.includes("dislike") ? "down" : "up";

  // Extract post ID
  const postIdMatch = text.match(/post\s+([a-zA-Z0-9_-]+)/i);
  const postId = postIdMatch ? postIdMatch[1] : undefined;

  // Extract comment ID
  const commentIdMatch = text.match(/comment\s+([a-zA-Z0-9_-]+)/i);
  const commentId = commentIdMatch ? commentIdMatch[1] : undefined;

  return { postId, commentId, direction };
}

export default voteAction;
