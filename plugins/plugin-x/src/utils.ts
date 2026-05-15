import { logger, truncateToCompleteSentence } from "@elizaos/core";
import type { ClientBase } from "./base";
import { TWEET_MAX_LENGTH } from "./constants";
import type { ActionResponse, MediaData } from "./types";

/**
 * Minimal shape we rely on from the Twitter v2 send-tweet response after
 * unwrapping the `{ data: { data: { ... } } }` envelopes returned by our
 * request helpers.
 */
export interface SentTweet {
  id: string;
  text?: string;
  edit_history_tweet_ids?: string[];
  readonly [extra: string]: unknown;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SendTweetResponse = Awaited<
  ReturnType<ClientBase["twitterClient"]["sendTweet"]>
>;

function unwrapSentTweet(response: SendTweetResponse): SentTweet | undefined {
  if (!response || typeof response !== "object") return undefined;

  const outer = response as { data?: unknown };
  const middle =
    outer.data && typeof outer.data === "object"
      ? (outer.data as { data?: unknown })
      : undefined;
  const inner = middle?.data ?? outer.data ?? response;

  if (inner && typeof inner === "object" && "id" in inner) {
    const candidate = inner as { id: unknown };
    if (typeof candidate.id === "string") {
      return inner as SentTweet;
    }
  }
  return undefined;
}

export async function sendTweet(
  client: ClientBase,
  text: string,
  mediaData: MediaData[] = [],
  tweetToReplyTo?: string,
  mediaIds?: string[],
): Promise<SentTweet> {
  const isNoteTweet = text.length > TWEET_MAX_LENGTH;
  const postText = isNoteTweet
    ? truncateToCompleteSentence(text, TWEET_MAX_LENGTH)
    : text;

  let result: SendTweetResponse;

  try {
    result = await client.twitterClient.sendTweet(
      postText,
      tweetToReplyTo,
      mediaData,
      false,
      mediaIds,
    );
    logger.log("Successfully posted Tweet");
  } catch (error) {
    logger.error("Error posting Tweet:", errorDetail(error));
    throw error;
  }

  const tweetResult = unwrapSentTweet(result);
  if (!tweetResult) {
    logger.error("No valid response from Twitter API");
    throw new Error("Failed to send tweet - no valid response");
  }

  try {
    if (
      client.lastCheckedTweetId === null ||
      client.lastCheckedTweetId < BigInt(tweetResult.id)
    ) {
      client.lastCheckedTweetId = BigInt(tweetResult.id);
    }
    await client.cacheLatestCheckedTweetId();

    await client.cacheTweet({
      ...tweetResult,
      userId: "",
      username: "",
      name: "",
      conversationId: tweetResult.id,
      timestamp: Date.now(),
      photos: [],
      mentions: [],
      hashtags: [],
      urls: [],
      videos: [],
      thread: [],
      permanentUrl: "",
    });

    logger.log("Successfully posted a tweet", tweetResult.id);
  } catch (error) {
    logger.error("Error parsing tweet response:", errorDetail(error));
    throw error;
  }

  return tweetResult;
}

/**
 * Parses the action response from the given text.
 *
 * @param {string} text - The text to parse actions from.
 * @returns {{ actions: ActionResponse }} The parsed actions with boolean values indicating if each action is present in the text.
 */
export const parseActionResponseFromText = (
  text: string,
): { actions: ActionResponse } => {
  const actions: ActionResponse = {
    like: false,
    retweet: false,
    quote: false,
    reply: false,
  };

  // Regex patterns
  const likePattern = /\[LIKE\]/i;
  const retweetPattern = /\[RETWEET\]/i;
  const quotePattern = /\[QUOTE\]/i;
  const replyPattern = /\[REPLY\]/i;

  // Check with regex
  actions.like = likePattern.test(text);
  actions.retweet = retweetPattern.test(text);
  actions.quote = quotePattern.test(text);
  actions.reply = replyPattern.test(text);

  // Also do line by line parsing as backup
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[LIKE]") actions.like = true;
    if (trimmed === "[RETWEET]") actions.retweet = true;
    if (trimmed === "[QUOTE]") actions.quote = true;
    if (trimmed === "[REPLY]") actions.reply = true;
  }

  return { actions };
};
