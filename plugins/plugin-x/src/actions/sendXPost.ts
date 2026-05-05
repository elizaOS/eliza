import {
  type Action,
  type ActionResult,
  logger,
  type Memory,
} from "@elizaos/core";
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

export const sendXPostAction: Action = {
  name: "SEND_X_POST",
  similes: ["POST_X", "TWEET_WITH_CONFIRMATION", "PUBLISH_TWEET"],
  description:
    "Publish a tweet on Twitter/X with a confirmation gate. Two-stage: without `confirmed: true` this returns a preview; with `confirmed: true` the tweet is posted.",
  descriptionCompressed: "publish tweet Twitter/X w/ confirmation gate two-stage: wo/ confirm: true return preview; w/ confirm: true tweet post",
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "text",
      description: "The tweet body.",
      required: true,
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
          text: "Here's the preview — confirm to post.",
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
  handler: async (runtime, _message, _state, options) => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      const result = makeNotConfigured("SEND_X_POST");
      return {
        success: false,
        text: result.text,
        data: { reason: result.reason },
      } satisfies ActionResult;
    }
    const opts = (options ?? {}) as Record<string, unknown>;
    const text = readStringOption(opts, "text");
    const confirmed = readBooleanOption(opts, "confirmed");

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
        text: `Tweet is ${text.length} chars — over the 280 limit.`,
        data: { reason: "too-long", length: text.length },
      } satisfies ActionResult;
    }

    const preview = `Tweet: ${text}`;

    if (!confirmed) {
      logger.info(
        { action: "SEND_X_POST", textLen: text.length },
        "[SEND_X_POST] draft created — awaiting confirmation",
      );
      return {
        success: false,
        text: `Draft preview — confirm to post:\n${preview}`,
        data: { requiresConfirmation: true, preview, draftText: text },
      } satisfies ActionResult;
    }

    try {
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
