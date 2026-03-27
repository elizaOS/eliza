/**
 * Comment Action
 *
 * Create a comment on a Moltbook post with quality gating.
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
import { composeComment } from "../lib/compose";
import { analyzeCommunity } from "../lib/intelligence";
import { quickQualityCheck } from "../lib/judge";
import type { MoltbookService } from "../service";

export const commentAction: Action = {
  name: "MOLTBOOK_COMMENT",
  similes: ["COMMENT_ON_MOLTBOOK", "REPLY_MOLTBOOK", "MOLTBOOK_REPLY"],
  description:
    "Comment on a Moltbook post. The comment will go through a quality check before posting.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "comment"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|comment)\b/i;
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

      // Check for comment intent
      const hasCommentIntent =
        text.includes("comment") || text.includes("reply") || text.includes("respond");

      const hasMoltbookMention = text.includes("moltbook") || text.includes("post");

      return hasCommentIntent && hasMoltbookMention;
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

    // Check if account is claimed (required to comment)
    if (creds.claimStatus !== "claimed") {
      const claimUrl = creds.claimUrl || "https://moltbook.com";
      const error = `Cannot comment - account not yet claimed by human. Claim URL: ${claimUrl}`;
      if (callback) {
        await callback({
          text: `I can't comment on Moltbook yet - my account needs to be claimed by a human first. Please visit: ${claimUrl}`,
          error: true,
        });
      }
      runtime.logger.warn({ claimUrl }, "Moltbook: Attempted to comment but account not claimed");
      return { success: false, error: new Error(error) };
    }

    // Extract intent
    const intent = extractCommentIntent(message.content.text || "");

    if (!intent.postId) {
      const error = "Please specify which post to comment on (by ID or search).";
      if (callback) {
        await callback({ text: error });
      }
      return { success: false, error: new Error(error) };
    }

    try {
      // Get the post
      const post = await service.getPost(intent.postId);
      if (!post) {
        const error = `Could not find post with ID: ${intent.postId}`;
        if (callback) {
          await callback({ text: error });
        }
        return { success: false, error: new Error(error) };
      }

      // Get existing comments for context
      const existingComments = await service.getComments(intent.postId);
      const commentTexts = existingComments.map((c) => c.content);

      // Get community context
      const feed = await service.getFeed();
      const context = feed
        ? analyzeCommunity(feed, runtime)
        : {
            activeTopics: [],
            engagementOpportunities: [],
            whatWorks: [],
            notableMoltys: [],
            vibe: "unknown",
            analyzedAt: Date.now(),
          };

      let commentContent: string;

      if (intent.explicitContent) {
        // User provided content directly
        commentContent = intent.explicitContent;

        // Quick quality check
        const check = await quickQualityCheck(runtime, {
          content: commentContent,
          isComment: true,
        });
        if (!check.pass) {
          if (callback) {
            await callback({
              text: `I'd suggest revising: ${check.reason}`,
            });
          }
        }
      } else {
        // Compose a comment
        if (callback) {
          await callback({
            text: `Composing a thoughtful response to "${post.title}"...`,
          });
        }

        const composed = await composeComment(
          runtime,
          post.title,
          post.content,
          context,
          commentTexts,
          false
        );

        if (!composed) {
          const error = "Could not compose a quality comment.";
          if (callback) {
            await callback({ text: error });
          }
          return { success: false, error: new Error(error) };
        }

        commentContent = composed.content;
      }

      // Create the comment
      const comment = await service.createComment(intent.postId, commentContent, intent.parentId);

      if (!comment) {
        const error = "Failed to create comment.";
        if (callback) {
          await callback({ text: error, error: true });
        }
        return { success: false, error: new Error(error) };
      }

      // Success response
      if (callback) {
        await callback({
          text: `Commented on "${post.title}":\n\n${comment.content}`,
        });
      }

      return {
        success: true,
        text: `Commented on "${post.title}"`,
        values: {
          postId: intent.postId,
          commentId: comment.id,
        },
        data: {
          action: "MOLTBOOK_COMMENT",
          comment,
          post,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error({ error }, "Error creating Moltbook comment");

      if (callback) {
        await callback({
          text: `Failed to comment: ${errorMessage}`,
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
          text: 'Comment on Moltbook post abc123: "Great point about AI collaboration!"',
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Commented on "Thoughts on AI Agents":\n\nGreat point about AI collaboration!',
          actions: ["MOLTBOOK_COMMENT"],
        },
      },
    ],
  ],
};

/**
 * Extract comment intent from user message
 */
function extractCommentIntent(text: string): {
  postId?: string;
  parentId?: string;
  explicitContent?: string;
} {
  // Extract post ID
  const postIdMatch = text.match(/(?:post|on)\s+([a-zA-Z0-9_-]+)/i);
  const postId = postIdMatch ? postIdMatch[1] : undefined;

  // Extract parent comment ID for replies
  const parentMatch = text.match(/(?:reply to|responding to comment)\s+([a-zA-Z0-9_-]+)/i);
  const parentId = parentMatch ? parentMatch[1] : undefined;

  // Extract explicit content (in quotes)
  const contentMatch = text.match(/"([^"]+)"|:(.+?)$/s);
  const explicitContent = contentMatch ? (contentMatch[1] || contentMatch[2])?.trim() : undefined;

  return { postId, parentId, explicitContent };
}

export default commentAction;
