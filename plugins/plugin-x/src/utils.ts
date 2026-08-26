/**
 * Shared tweet-sending and media helpers for the connector: `sendTweet` (publishes
 * text, splitting into threads and honoring the max length, returning the accepted
 * `SentTweet`), `fetchMediaData` (SSRF-guarded, size-capped attachment download), and
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
  inReplyTo: string,
): Promise<Memory[]> {
  return client.withAuthenticatedSession(async (session) => {
    const messages: Memory[] = [];
    const chunks = splitTweetContent(content.text ?? "", TWEET_MAX_LENGTH);
    let previousTweetId = inReplyTo;
    const mediaData =
      content.attachments && content.attachments.length > 0
        ? await fetchMediaData(content.attachments)
        : [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      const tweetContent = `${chunk}`;
      logger.debug(`Sending tweet ${i + 1}/${chunks.length}: ${tweetContent}`);

      try {
        if (!client.isAuthenticatedSessionCurrent(session)) {
          throw new ElizaError("X credentials rotated during thread egress", {
            code: "X_AUTH_SESSION_ROTATED",
          });
        }
        const result = await sendTweet(
          client,
          tweetContent,
          i === 0 ? mediaData : [],
          previousTweetId,
        );
        const tweetResult =
          typeof result.data === "object" && result.data !== null
            ? result.data
            : result;

        if (
          typeof tweetResult === "object" &&
          tweetResult !== null &&
          "id" in tweetResult &&
          typeof tweetResult.id === "string"
        ) {
          const tweetId = tweetResult.id;
          messages.push({
            id: createUniqueUuid(client.runtime, tweetId),
            entityId: client.runtime.agentId,
            content: {
              text: chunk,
              url: `https://x.com/${session.profile.username}/status/${tweetId}`,
              source: "twitter",
            },
            agentId: client.runtime.agentId,
            roomId,
            createdAt: Date.now(),
          });
          previousTweetId = tweetId;
        }
      } catch (error) {
        logger.error(`Error sending chunk ${i + 1}:`, errorDetail(error));
        throw error;
      }
    }

    return messages;
  });
}

/**
 * Split content into ordered posts without rewriting or dropping any text.
 * URLs stay indivisible because X gives each complete URL a fixed wire weight.
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
  const urlPattern = /https?:\/\/[^\s]+/gu;
  let cursor = 0;
  for (const match of content.matchAll(urlPattern)) {
    const index = match.index;
    units.push(...Array.from(content.slice(cursor, index)));
    units.push(match[0]);
    cursor = index + match[0].length;
  }
  units.push(...Array.from(content.slice(cursor)));

  const chunks: string[] = [];
  let chunk = "";
  let chunkWeight = 0;
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
    if (chunk && chunkWeight + unitWeight > maxLength) {
      chunks.push(chunk);
      chunk = unit;
      chunkWeight = unitWeight;
    } else {
      chunk += unit;
      chunkWeight += unitWeight;
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
