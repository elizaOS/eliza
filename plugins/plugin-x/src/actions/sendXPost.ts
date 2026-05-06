import {
  type Action,
  type ActionResult,
  createUniqueUuid,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { TwitterPostService } from "../services/PostService.js";
import type { XService } from "../services/x.service.js";
import { terminalActionResultData } from "./actionResultSemantics.js";
import { resolveXFeedAdapter } from "./x-feed-adapter.js";
import {
  extractRetryAfterSeconds,
  isRateLimitError,
  makeNotConfigured,
  makeRateLimited,
  readBooleanOption,
  readStringOption,
} from "./x-feed-helpers.js";

function getXService(runtime: {
  getService?: (name: string) => unknown;
}): XService | null {
  return (runtime.getService?.("x") ??
    runtime.getService?.("twitter") ??
    null) as XService | null;
}

export const sendXPostAction: Action = {
  name: "SEND_X_POST",
  similes: [
    "POST_X",
    "POST_TWEET",
    "TWEET",
    "SEND_TWEET",
    "TWITTER_POST",
    "POST_ON_TWITTER",
    "SHARE_ON_TWITTER",
    "TWEET_WITH_CONFIRMATION",
    "PUBLISH_TWEET",
  ],
  description:
    "Publish a tweet on Twitter/X with a confirmation gate. Supports replies via replyToTweetId. Two-stage: without `confirmed: true` this returns a preview; with `confirmed: true` the tweet is posted.",
  descriptionCompressed:
    "Post tweet on X (Twitter); supports replies via replyToTweetId.",
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "text",
      description: "The tweet body.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "replyToTweetId",
      description: "Tweet id to reply to. When set, posts as a reply.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Must be true for the tweet to actually post.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Post: shipped Eliza today" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here's the preview - confirm to post.",
          action: "SEND_X_POST",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    const mentionsX = /\b(x|twitter|x\.com)\b/.test(text);
    const isPostLike = /\bpost:|\btweet\b|\bshare\b/.test(text);
    return isPostLike || (mentionsX && /\bpost\b/.test(text));
  },
  handler: async (runtime, message, _state, options) => {
    const opts = (options ?? {}) as Record<string, unknown>;
    const text = readStringOption(opts, "text");
    const confirmed = readBooleanOption(opts, "confirmed");
    const replyToTweetId =
      readStringOption(opts, "replyToTweetId") ??
      readStringOption(opts, "inReplyTo") ??
      readStringOption(opts, "tweetId");

    if (!text) {
      return {
        success: false,
        text: "SEND_X_POST requires a `text` parameter.",
        data: { reason: "missing-parameters" },
      } satisfies ActionResult;
    }
    if (text.length > 280) {
      return {
        success: false,
        text: `Tweet is ${text.length} chars - over the 280 limit.`,
        data: { reason: "too-long", length: text.length },
      } satisfies ActionResult;
    }

    const preview = replyToTweetId
      ? `Reply to ${replyToTweetId}: ${text}`
      : `Tweet: ${text}`;

    if (!confirmed) {
      logger.info(
        { action: "SEND_X_POST", textLen: text.length, replyToTweetId },
        "[SEND_X_POST] draft created - awaiting confirmation",
      );
      return {
        success: false,
        text: `Draft preview - confirm to post:\n${preview}`,
        data: {
          requiresConfirmation: true,
          preview,
          draftText: text,
          ...(replyToTweetId ? { replyToTweetId } : {}),
        },
      } satisfies ActionResult;
    }

    try {
      if (replyToTweetId) {
        const service = getXService(runtime);
        if (!service?.twitterClient?.client) {
          const result = makeNotConfigured("SEND_X_POST");
          return {
            success: false,
            text: result.text,
            data: { reason: result.reason },
          } satisfies ActionResult;
        }
        const postService = new TwitterPostService(
          service.twitterClient.client,
        );
        const post = await postService.createPost({
          agentId: runtime.agentId,
          roomId:
            message.roomId ??
            (createUniqueUuid(runtime, replyToTweetId) as UUID),
          text,
          inReplyTo: replyToTweetId,
        });
        logger.info(
          { action: "SEND_X_POST", tweetId: post.id, replyToTweetId },
          "[SEND_X_POST] posted reply",
        );
        return {
          success: true,
          text: "Posted X reply.",
          data: terminalActionResultData({
            tweetId: post.id,
            postedText: text,
            replyToTweetId,
          }),
        } satisfies ActionResult;
      }

      const adapter = resolveXFeedAdapter(runtime);
      if (!adapter) {
        const result = makeNotConfigured("SEND_X_POST");
        return {
          success: false,
          text: result.text,
          data: { reason: result.reason },
        } satisfies ActionResult;
      }

      const sent = await adapter.createTweet({ text });
      logger.info(
        { action: "SEND_X_POST", tweetId: sent.id },
        "[SEND_X_POST] posted confirmed tweet",
      );
      return {
        success: true,
        text: `Posted tweet.`,
        data: terminalActionResultData({ tweetId: sent.id, postedText: text }),
      } satisfies ActionResult;
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "SEND_X_POST",
          extractRetryAfterSeconds(error),
        );
        return {
          success: false,
          text: result.text,
          data: {
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
          },
        } satisfies ActionResult;
      }
      throw error;
    }
  },
};
