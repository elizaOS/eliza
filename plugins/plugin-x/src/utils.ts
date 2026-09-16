/**
 * Shared tweet-sending and media helpers for the connector: single-post and
 * ordered-thread delivery, SSRF-guarded attachment loading, and
 * `parseActionResponseFromText` (extracts the model's like/retweet/quote/reply
 * choice). Re-exports the shared API error handler.
 */
import fs from "node:fs";
import path from "node:path";
import type { Media } from "@elizaos/core";
import {
  type Content,
  createUniqueUuid,
  DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
  ElizaError,
  fetchRemoteMedia,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import twitterText from "twitter-text";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TWEET_MAX_LENGTH } from "./constants";
import { countTwitterWeightedLength } from "./tweet-length";
import type { ActionResponse, MediaData } from "./types";
import { normalizeXReceiptId } from "./utils/provider-receipt";

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

/** Provider receipt paired with the exact chunk accepted for that post. */
export interface TweetThreadReceipt {
  id: string;
  text: string;
}

/** X direct-message text accepts at most 10,000 Unicode characters per send. */
export const X_MAX_DM_LENGTH = 10_000;

// The pinned runtimes provide Intl.Segmenter, while this package's ES2020
// declaration library does not expose its type.
const GraphemeSegmenter = (
  Intl as unknown as {
    Segmenter: new (
      locale: string,
      options: { granularity: "grapheme" },
    ) => { segment(text: string): Iterable<{ segment: string }> };
  }
).Segmenter;

const xGraphemeSegmenter = new GraphemeSegmenter("en", {
  granularity: "grapheme",
});

/** Split direct-message text on Unicode scalar boundaries without dropping it. */
export function splitXDirectMessageContent(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += X_MAX_DM_LENGTH) {
    chunks.push(characters.slice(index, index + X_MAX_DM_LENGTH).join(""));
  }
  return chunks;
}

/** Send complete text through a caller-owned first/reply transport. */
export async function sendTextAsTweetThread(
  text: string,
  sendChunk: (
    chunk: string,
    previousTweetId: string | undefined,
    index: number,
  ) => Promise<SentTweet>,
  maxLength: number = TWEET_MAX_LENGTH,
): Promise<TweetThreadReceipt[]> {
  const receipts: TweetThreadReceipt[] = [];
  for (const [index, chunk] of splitTweetContent(text, maxLength).entries()) {
    const receipt = await sendChunk(chunk, receipts[index - 1]?.id, index);
    receipts.push({ id: receipt.id, text: chunk });
  }
  return receipts;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const wait = (minTime = 1000, maxTime = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export const isValidTweet = (tweet: Tweet): boolean => {
  // Filter out tweets with too many hashtags, @s, or $ signs, probably spam or garbage
  const hashtagCount = (tweet.text?.match(/#/g) || []).length;
  const atCount = (tweet.text?.match(/@/g) || []).length;
  const dollarSignCount = (tweet.text?.match(/\$/g) || []).length;
  const totalCount = hashtagCount + atCount + dollarSignCount;

  return (
    hashtagCount <= 1 && atCount <= 2 && dollarSignCount <= 1 && totalCount <= 3
  );
};

async function readLocalAttachment(resolvedPath: string): Promise<Buffer> {
  const handle = await fs.promises.open(resolvedPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(
        `File not found: ${resolvedPath}. Make sure the path is correct.`,
      );
    }
    if (
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES
    ) {
      throw new ElizaError(
        `X attachment exceeds ${DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES} bytes`,
        {
          code: "X_ATTACHMENT_TOO_LARGE",
          context: {
            path: resolvedPath,
            bytes: stat.size,
            maxBytes: DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
          },
        },
      );
    }

    const mediaBuffer = Buffer.allocUnsafe(stat.size);
    let total = 0;
    while (total < mediaBuffer.length) {
      const { bytesRead } = await handle.read(
        mediaBuffer,
        total,
        mediaBuffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total === mediaBuffer.length
      ? mediaBuffer
      : mediaBuffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/**
 * Fetches media data from a list of attachments, supporting both HTTP URLs and local file paths.
 * Remote URLs go through {@link fetchRemoteMedia} (SSRF guard +
 * {@link DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES}) so a lying or missing
 * Content-Length cannot force an unbounded `arrayBuffer()`.
 */
export async function fetchMediaData(
  attachments: Media[],
): Promise<MediaData[]> {
  return Promise.all(
    attachments.map(async (attachment: Media) => {
      if (/^(http|https):\/\//.test(attachment.url)) {
        const { buffer, contentType } = await fetchRemoteMedia({
          url: attachment.url,
          maxBytes: DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
          timeoutMs: 30_000,
        });
        return {
          data: buffer,
          mediaType: attachment.contentType || contentType || "image/png",
        };
      }
      const resolvedPath = path.resolve(attachment.url);
      const mediaBuffer = await readLocalAttachment(resolvedPath);
      return {
        data: mediaBuffer,
        mediaType: attachment.contentType || "image/png",
      };
    }),
  );
}

/**
 * Send a standard tweet through the client
 */
export async function sendStandardTweet(
  client: ClientBase,
  content: string,
  tweetId?: string,
  mediaData?: MediaData[],
) {
  return client.withAuthenticatedSession(async (session) => {
    if (!client.isAuthenticatedSessionCurrent(session)) {
      throw new ElizaError("X credentials rotated before post egress", {
        code: "X_AUTH_SESSION_ROTATED",
      });
    }
    return client.twitterClient.sendTweet(content, tweetId, mediaData);
  });
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
    const id = normalizeXReceiptId(candidate.id);
    if (id) {
      return { ...(inner as Record<string, unknown>), id } as SentTweet;
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
  const weightedLength = countTwitterWeightedLength(text);
  if (weightedLength > TWEET_MAX_LENGTH) {
    throw new ElizaError(
      `X posts are limited to ${TWEET_MAX_LENGTH} weighted characters; received ${weightedLength}`,
      {
        code: "X_POST_LENGTH_EXCEEDED",
        context: {
          weightedLength,
          maxWeightedLength: TWEET_MAX_LENGTH,
        },
      },
    );
  }
  return client.withAuthenticatedSession(async (session) => {
    const { profile } = session;

    if (!client.isAuthenticatedSessionCurrent(session)) {
      throw new ElizaError("X credentials rotated before post egress", {
        code: "X_AUTH_SESSION_ROTATED",
      });
    }
    const result: SendTweetResponse = await client.twitterClient.sendTweet(
      text,
      tweetToReplyTo,
      mediaData,
      false,
      mediaIds,
    );
    logger.info("Successfully posted Tweet");

    const tweetResult = unwrapSentTweet(result);
    if (!tweetResult) {
      throw new ElizaError("X returned no usable post receipt", {
        code: "X_POST_RESPONSE_INVALID",
      });
    }

    try {
      // Do NOT advance the mention cursor (`lastCheckedTweetId`) on an outgoing
      // publish. That cursor is the primary gate `processMentionTweets` uses to
      // decide which incoming @mentions are new; because a freshly-published
      // tweet always has the newest snowflake id, moving it here would silently
      // skip every unprocessed mention that arrived before this post. The
      // interactions loop owns and persists the cursor, and the self-tweet
      // filter (`tweet.userId !== profileId`) already prevents self-replies, so
      // the only local bookkeeping a send needs is caching the tweet itself.
      await client.cacheTweet({
        ...tweetResult,
        userId: profile.id,
        username: profile.username,
        name: profile.screenName,
        conversationId: tweetResult.id,
        timestamp: Date.now(),
        photos: [],
        mentions: [],
        hashtags: [],
        urls: [],
        videos: [],
        thread: [],
        permanentUrl: `https://x.com/${profile.username}/status/${tweetResult.id}`,
      });
      logger.info("Successfully posted a tweet", tweetResult.id);
    } catch (error) {
      // error-policy:J7 X already accepted the post, so retrying would duplicate
      // an external effect. Surface the local receipt failure and return the
      // accepted provider result exactly once.
      client.runtime.reportError("X.sendTweet.localReceipt", error, {
        accountId: client.accountId,
        tweetId: tweetResult.id,
      });
    }

    return tweetResult;
  });
}

/**
 * Sends a tweet on Twitter using the given client.
 *
 * @param {ClientBase} client The client used to send the tweet.
 * @param {Content} content The content of the tweet.
 * @param {UUID} roomId The ID of the room where the tweet will be sent.
 * @param {string} twitterUsername The Twitter username of the sender.
 * @param {string} inReplyTo The ID of the tweet to which the new tweet will reply.
 * @returns {Promise<Memory[]>} An array of memories representing the sent tweets.
 */
export async function sendChunkedTweet(
  client: ClientBase,
  content: Content,
  roomId: UUID,
  _twitterUsername: string,
  inReplyTo?: string,
): Promise<Memory[]> {
  return client.withAuthenticatedSession(async (session) => {
    const mediaData =
      content.attachments && content.attachments.length > 0
        ? await fetchMediaData(content.attachments)
        : [];

    const receipts = await sendTextAsTweetThread(
      content.text ?? "",
      async (chunk, previousTweetId, index) => {
        logger.debug(`Sending tweet chunk ${index + 1}: ${chunk}`);
        if (!client.isAuthenticatedSessionCurrent(session)) {
          throw new ElizaError("X credentials rotated during thread egress", {
            code: "X_AUTH_SESSION_ROTATED",
          });
        }
        try {
          return await sendTweet(
            client,
            chunk,
            index === 0 ? mediaData : [],
            previousTweetId ?? inReplyTo,
          );
        } catch (error) {
          logger.error(`Error sending chunk ${index + 1}:`, errorDetail(error));
          throw error;
        }
      },
    );

    return receipts.map(({ id: tweetId, text }) => ({
      id: createUniqueUuid(client.runtime, tweetId),
      entityId: client.runtime.agentId,
      content: {
        text,
        url: `https://x.com/${session.profile.username}/status/${tweetId}`,
        source: "twitter",
      },
      metadata: {
        type: "message",
        source: "twitter",
        accountId: client.accountId,
        provider: "twitter",
        messageIdFull: tweetId,
        fromBot: true,
      } satisfies Memory["metadata"],
      agentId: client.runtime.agentId,
      roomId,
      createdAt: Date.now(),
    }));
  });
}

/**
 * Split content into ordered posts without rewriting or dropping any text.
 * URL boundaries come from twitter-text, the same parser used to enforce X's
 * weighted limit, so trailing punctuation remains ordinary splittable text.
 */
export function splitTweetContent(
  content: string,
  maxLength: number,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new ElizaError("X post chunk limit must be a positive safe integer", {
      code: "X_POST_CHUNK_LIMIT_INVALID",
      context: { maxLength },
    });
  }
  if (!content) return [];

  const units: string[] = [];
  let cursor = 0;
  const appendTextUnits = (text: string) => {
    for (const { segment } of xGraphemeSegmenter.segment(text)) {
      units.push(segment);
    }
  };
  for (const entity of twitterText.extractUrlsWithIndices(content)) {
    const [start, end] = entity.indices;
    appendTextUnits(content.slice(cursor, start));
    units.push(content.slice(start, end));
    cursor = end;
  }
  appendTextUnits(content.slice(cursor));

  const chunks: string[] = [];
  let chunk = "";
  for (const unit of units) {
    const unitWeight = countTwitterWeightedLength(unit);
    if (unitWeight > maxLength) {
      throw new ElizaError(
        "An indivisible X post token exceeds the provider limit",
        {
          code: "X_POST_TOKEN_TOO_LONG",
          context: { maxLength },
        },
      );
    }
    const candidate = `${chunk}${unit}`;
    if (chunk && countTwitterWeightedLength(candidate) > maxLength) {
      chunks.push(chunk);
      chunk = unit;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * Deduplicates mentions at the beginning of a paragraph.
 *
 * @param {string} paragraph - The input paragraph containing mentions.
 * @returns {string} - The paragraph with deduplicated mentions.
 */
function _deduplicateMentions(paragraph: string) {
  // Regex to match mentions at the beginning of the string
  const mentionRegex = /^@(\w+)(?:\s+@(\w+))*(\s+|$)/;

  // Find all matches
  const matches = paragraph.match(mentionRegex);

  if (!matches) {
    return paragraph; // If no matches, return the original string
  }

  // Extract mentions from the match groups
  let mentions = matches.slice(0, 1)[0].trim().split(" ");

  // Deduplicate mentions
  mentions = Array.from(new Set(mentions));

  // Reconstruct the string with deduplicated mentions
  const uniqueMentionsString = mentions.join(" ");

  // Find where the mentions end in the original string
  const endOfMentions = paragraph.indexOf(matches[0]) + matches[0].length;

  // Construct the result by combining unique mentions with the rest of the string
  return `${uniqueMentionsString} ${paragraph.slice(endOfMentions)}`;
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

// Export error handler utilities
export * from "./utils/error-handler";
