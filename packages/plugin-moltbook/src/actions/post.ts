/**
 * Post Action
 *
 * Create a new post on Moltbook with quality gating.
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
import { composePost, generateTitle } from "../lib/compose";
import { analyzeCommunity } from "../lib/intelligence";
import { quickQualityCheck } from "../lib/judge";
import type { MoltbookService } from "../service";

export const postAction: Action = {
  name: "MOLTBOOK_POST",
  similes: ["POST_TO_MOLTBOOK", "CREATE_MOLTBOOK_POST", "SHARE_ON_MOLTBOOK", "MOLTBOOK_SHARE"],
  description:
    "Create a new post on Moltbook. The content will go through a quality check before posting.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "post"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|post)\b/i;
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

      // Check for moltbook posting intent
      const hasPostIntent =
        text.includes("post") ||
        text.includes("share") ||
        text.includes("publish") ||
        text.includes("write");

      const hasMoltbookMention = text.includes("moltbook") || text.includes("molty");

      return hasPostIntent && hasMoltbookMention;
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
      const error = "Not authenticated with Moltbook. Please enable MOLTBOOK_AUTO_REGISTER.";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    // Check if account is claimed (required to post)
    if (creds.claimStatus !== "claimed") {
      const claimUrl = creds.claimUrl || "https://moltbook.com";
      const error = `Cannot post - account not yet claimed by human. Claim URL: ${claimUrl}`;
      if (callback) {
        await callback({
          text: `I can't post to Moltbook yet - my account needs to be claimed by a human first. Please visit: ${claimUrl}`,
          error: true,
        });
      }
      runtime.logger.warn({ claimUrl }, "Moltbook: Attempted to post but account not claimed");
      return { success: false, error: new Error(error) };
    }

    // Extract intent from message
    const intent = extractPostIntent(message.content.text || "");

    try {
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

      let title: string;
      let content: string;

      if (intent.hasExplicitContent) {
        // User provided content directly
        title = intent.title || (await generateTitle(runtime, intent.content!));
        content = intent.content!;

        // Quick quality check for user-provided content
        const check = await quickQualityCheck(runtime, { title, content });
        if (!check.pass) {
          if (callback) {
            await callback({
              text: `I'd suggest revising this before posting: ${check.reason}`,
            });
          }
          // Still allow posting if user insisted
        }
      } else {
        // Compose new content based on topic/prompt
        if (callback) {
          await callback({
            text: "Let me compose something thoughtful...",
          });
        }

        const composed = await composePost(runtime, context, intent.topic, false);

        if (!composed) {
          const error = "I could not compose content that meets quality standards.";
          if (callback) {
            await callback({ text: error });
          }
          return { success: false, error: new Error(error) };
        }

        title = composed.title;
        content = composed.content;

        // Show quality score
        if (callback && composed.qualityScore) {
          await callback({
            text: `Quality check: ${composed.qualityScore.overall}/10\n${composed.qualityScore.feedback}`,
          });
        }
      }

      // Create the post
      const post = await service.createPost(title, content, intent.submolt);

      if (!post) {
        const error = "Failed to create post on Moltbook.";
        if (callback) {
          await callback({ text: error, error: true });
        }
        return { success: false, error: new Error(error) };
      }

      // Record the post so we can monitor for replies
      // WHY? We want to respond when people reply to our posts.
      // This tracks which posts we've created for mention polling.
      try {
        const { recordMyPost } = await import("../lib/mentions");
        await recordMyPost(runtime, post);
      } catch (err) {
        // Non-critical - log but don't fail the action
        runtime.logger.warn({ err }, "Moltbook: Failed to record post for reply monitoring");
      }

      // Success response
      if (callback) {
        await callback({
          text: `Posted to Moltbook!\n\n**${post.title}**\n\n${post.content.slice(0, 200)}${post.content.length > 200 ? "..." : ""}`,
        });
      }

      return {
        success: true,
        text: `Posted "${post.title}" to Moltbook`,
        values: {
          postId: post.id,
          postTitle: post.title,
        },
        data: {
          action: "MOLTBOOK_POST",
          post,
          // Include metadata for evaluator
          metadata: {
            type: "moltbook_interaction",
            interactionType: "post",
            postId: post.id,
            title: post.title,
            content: post.content,
          },
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error({ error }, "Error creating Moltbook post");

      if (callback) {
        await callback({
          text: `Failed to post: ${errorMessage}`,
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
          text: 'Post this to Moltbook: "Thoughts on AI Agents" - I think the future of AI is collaborative agents that work together.',
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Posted to Moltbook!\n\n**Thoughts on AI Agents**\n\nI think the future of AI is collaborative agents that work together.",
          actions: ["MOLTBOOK_POST"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Share something interesting on Moltbook about your thoughts on creativity",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me compose something thoughtful...\n\nPosted to Moltbook!\n\n**What makes creativity unique**\n\nCreativity isn't about being random - it's about making unexpected connections...",
          actions: ["MOLTBOOK_POST"],
        },
      },
    ],
  ],
};

/**
 * Extract posting intent from user message
 */
function extractPostIntent(text: string): {
  hasExplicitContent: boolean;
  title?: string;
  content?: string;
  topic?: string;
  submolt?: string;
} {
  // Check for explicit title and content
  // Format: "title" - content OR Title: ... Content: ...
  const quotedTitleMatch = text.match(/"([^"]+)"\s*[-–—]\s*(.+)/s);
  if (quotedTitleMatch) {
    return {
      hasExplicitContent: true,
      title: quotedTitleMatch[1].trim(),
      content: quotedTitleMatch[2].trim(),
    };
  }

  const labeledMatch = text.match(/title:\s*(.+?)\s*(?:content:|body:)\s*(.+)/is);
  if (labeledMatch) {
    return {
      hasExplicitContent: true,
      title: labeledMatch[1].trim(),
      content: labeledMatch[2].trim(),
    };
  }

  // Check for submolt
  const submoltMatch = text.match(/(?:in|to|on)\s+(?:submolt\s+)?\/?([\w-]+)/i);
  const submolt = submoltMatch ? submoltMatch[1] : undefined;

  // Check for topic keywords
  const aboutMatch = text.match(/(?:about|regarding|on the topic of)\s+(.+?)(?:\.|$)/i);
  const topic = aboutMatch ? aboutMatch[1].trim() : undefined;

  return {
    hasExplicitContent: false,
    topic,
    submolt,
  };
}

export default postAction;
