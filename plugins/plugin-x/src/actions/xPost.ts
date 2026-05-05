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

function normalizeSubaction(value: unknown): "post" | "reply" {
  const normalized = String(value ?? "post")
    .trim()
    .toLowerCase();
  return normalized === "reply" ? "reply" : "post";
}

function extractPostText(
  message: Memory,
  options: Record<string, unknown>,
): string {
  const optionText = readStringOption(options, "text");
  if (optionText) {
    return optionText;
  }

  const text =
    typeof message.content?.text === "string"
      ? message.content.text.trim()
      : "";
  return text
    .replace(/^(post|tweet|share)(\s+on\s+(x|twitter))?:\s*/i, "")
    .trim();
}

function getXService(runtime: {
  getService?: (name: string) => unknown;
}): XService | null {
  return (runtime.getService?.("x") ??
    runtime.getService?.("twitter") ??
    null) as XService | null;
}

export const xPostAction: Action = {
  name: "X_POST",
  similes: [
    "POST_TWEET",
    "SEND_X_POST",
    "POST_X",
    "TWEET",
    "SEND_TWEET",
    "TWITTER_POST",
    "POST_ON_TWITTER",
    "SHARE_ON_TWITTER",
  ],
  description:
    "Create a public X/Twitter post or public reply. Direct messages are handled by the X DM connector.",
  descriptionCompressed:
    "public X/Twitter post router; subaction post|reply, no DMs",
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "subaction",
      description: "Public posting operation.",
      required: false,
      schema: { type: "string", enum: ["post", "reply"], default: "post" },
    },
    {
      name: "text",
      description: "The public post body.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Must be true for the public post to actually publish.",
      required: false,
      schema: { type: "boolean", default: false },
    },
    {
      name: "inReplyTo",
      description: "Tweet id to reply to when subaction is reply.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Post on X: shipped Eliza today" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Draft preview - confirm to post.",
          action: "X_POST",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    const mentionsX = /\b(x|twitter|x\.com)\b/.test(text);
    const isPublicPostLike = /\b(post|tweet|share|reply)\b/.test(text);
    const isDmLike = /\b(dm|direct message|private message)\b/.test(text);
    return isPublicPostLike && mentionsX && !isDmLike;
  },
  handler: async (runtime, message, _state, options) => {
    const opts = (options ?? {}) as Record<string, unknown>;
    const subaction = normalizeSubaction(opts.subaction);
    const text = extractPostText(message, opts);
    const confirmed = readBooleanOption(opts, "confirmed");
    const inReplyTo =
      readStringOption(opts, "inReplyTo") ??
      readStringOption(opts, "replyToId") ??
      readStringOption(opts, "tweetId");

    if (!text) {
      return {
        success: false,
        text: "X_POST requires a `text` parameter.",
        data: { reason: "missing-parameters", subaction },
      } satisfies ActionResult;
    }

    if (text.length > 280) {
      return {
        success: false,
        text: `X post is ${text.length} chars - over the 280 limit.`,
        data: { reason: "too-long", length: text.length, subaction },
      } satisfies ActionResult;
    }

    if (subaction === "reply" && !inReplyTo) {
      return {
        success: false,
        text: "X_POST reply requires an `inReplyTo` tweet id.",
        data: { reason: "missing-parameters", subaction },
      } satisfies ActionResult;
    }

    const preview =
      subaction === "reply"
        ? `Reply to ${inReplyTo}: ${text}`
        : `Post: ${text}`;
    if (!confirmed) {
      logger.info(
        { action: "X_POST", subaction, textLen: text.length },
        "[X_POST] draft created - awaiting confirmation",
      );
      return {
        success: false,
        text: `Draft preview - confirm to publish:\n${preview}`,
        data: {
          requiresConfirmation: true,
          preview,
          draftText: text,
          subaction,
        },
      } satisfies ActionResult;
    }

    const service = getXService(runtime);
    try {
      if (service?.twitterClient?.client) {
        const postService = new TwitterPostService(
          service.twitterClient.client,
        );
        const post = await postService.createPost({
          agentId: runtime.agentId,
          roomId:
            message.roomId ??
            (createUniqueUuid(runtime, inReplyTo ?? "x-public-post") as UUID),
          text,
          ...(subaction === "reply" && inReplyTo ? { inReplyTo } : {}),
        });
        logger.info(
          { action: "X_POST", subaction, tweetId: post.id },
          "[X_POST] published via post service",
        );
        return {
          success: true,
          text: subaction === "reply" ? "Posted X reply." : "Posted X post.",
          data: terminalActionResultData({
            tweetId: post.id,
            postedText: text,
            subaction,
            ...(inReplyTo ? { inReplyTo } : {}),
          }),
        } satisfies ActionResult;
      }

      const adapter = resolveXFeedAdapter(runtime);
      if (!adapter) {
        const result = makeNotConfigured("X_POST");
        return {
          success: false,
          text: result.text,
          data: { reason: result.reason, subaction },
        } satisfies ActionResult;
      }

      if (subaction === "reply") {
        return {
          success: false,
          text: "X reply posting requires the X service post client.",
          data: { reason: "not-supported", subaction },
        } satisfies ActionResult;
      }

      const sent = await adapter.createTweet({ text });
      logger.info(
        { action: "X_POST", subaction, tweetId: sent.id },
        "[X_POST] published via feed adapter",
      );
      return {
        success: true,
        text: "Posted X post.",
        data: terminalActionResultData({
          tweetId: sent.id,
          postedText: text,
          subaction,
        }),
      } satisfies ActionResult;
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "X_POST",
          extractRetryAfterSeconds(error),
        );
        return {
          success: false,
          text: result.text,
          data: {
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
            subaction,
          },
        } satisfies ActionResult;
      }
      throw error;
    }
  },
};
