/**
 * Shared tweet-sending and media helpers for the connector: single-post and
 * ordered-thread delivery, SSRF-guarded attachment loading, and
 * `parseActionResponseFromText` (extracts the model's like/retweet/quote/reply
 * choice). Re-exports the shared API error handler.
 */
import type { Media } from "@elizaos/core";
import {
  type Content,
  createUniqueUuid,
  ElizaError,
  logger,
  type Memory,
  type ResolveOutboundAttachmentOptions,
  resolveOutboundAttachmentBytes,
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

/** Split direct-message text on grapheme boundaries without dropping it. */
export function splitXDirectMessageContent(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkLength = 0;
  const flush = () => {
    if (chunk) {
      chunks.push(chunk);
      chunk = "";
      chunkLength = 0;
    }
  };
  for (const { segment } of xGraphemeSegmenter.segment(text)) {
    const segmentLength = Array.from(segment).length;
    if (segmentLength > X_MAX_DM_LENGTH) {
      // One grapheme alone exceeds the limit, so split that grapheme on
      // Unicode scalar boundaries; it is the only case with no clean cut.
      flush();
      const scalars = Array.from(segment);
      for (let index = 0; index < scalars.length; index += X_MAX_DM_LENGTH) {
        chunks.push(scalars.slice(index, index + X_MAX_DM_LENGTH).join(""));
      }
      continue;
    }
    if (chunkLength + segmentLength > X_MAX_DM_LENGTH) flush();
    chunk += segment;
    chunkLength += segmentLength;
  }
  flush();
  return chunks;
}

/** Send complete text through a caller-owned first/reply transport. */
/** Errors on which every thread caller aborts its cycle to refresh credentials. */
function isXAuthAbortError(error: unknown): boolean {
  return (
    error instanceof ElizaError &&
    (error.code === "X_AUTH_NOT_INITIALIZED" ||
      error.code === "X_AUTH_SESSION_ROTATED")
  );
}

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
    let receipt: SentTweet;
    try {
      receipt = await sendChunk(chunk, receipts[index - 1]?.id, index);
    } catch (error) {
      // error-policy:J2 once a chunk is public, a later failure must not look
      // like a plain refusal: the caller would send the whole thread again.
      // Auth errors pass through unchanged: callers abort the cycle on them.
      if (receipts.length === 0 || isXAuthAbortError(error)) throw error;
      throw new ElizaError("X thread was only partly posted", {
        code: "X_THREAD_PARTIALLY_POSTED",
        cause: error,
        context: { acceptedTweetIds: receipts.map((r) => r.id) },
      });
    }
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

/**
 * Resolves attachment bytes through the core outbound loader, the same one the
 * Discord, Telegram and Slack connectors use: `data:` URLs, media-store
 * handles (`/api/media/...`) and SSRF-guarded http(s) URLs. The MIME type comes
 * from the loaded bytes, because `Media.contentType` is only a coarse kind
 * such as "image".
 */
export async function fetchMediaData(
  attachments: Media[],
  localFetch?: ResolveOutboundAttachmentOptions["localFetch"],
): Promise<MediaData[]> {
  return Promise.all(
    attachments.map(async (attachment: Media) => {
      const { buffer, contentType } = await resolveOutboundAttachmentBytes(
        attachment.url,
        { localFetch },
      );
      return { data: buffer, mediaType: contentType };
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
  options: {
    /**
     * Called synchronously right before each chunk's post request is issued.
     * Callers use it to tell "nothing reached X" (auth, media fetch or upload
     * failures) from an outcome X may have accepted.
     */
    onPostRequest?: (index: number) => void;
  } = {},
): Promise<Memory[]> {
  return client.withAuthenticatedSession(async (session) => {
    const mediaData =
      content.attachments && content.attachments.length > 0
        ? await fetchMediaData(
            content.attachments,
            client.runtime.fetch ?? undefined,
          )
        : [];
    // X attaches media to a post only by uploaded media id.
    const mediaIds: string[] = [];
    for (const media of mediaData) {
      mediaIds.push(
        await client.twitterClient.uploadMedia(media.data, {
          mimeType: media.mediaType,
        }),
      );
    }

    const receipts = await sendTextAsTweetThread(
      content.text ?? "",
      async (chunk, previousTweetId, index) => {
        logger.debug(`Sending tweet chunk ${index + 1}: ${chunk}`);
        if (!client.isAuthenticatedSessionCurrent(session)) {
          throw new ElizaError("X credentials rotated during thread egress", {
            code: "X_AUTH_SESSION_ROTATED",
          });
        }
        options.onPostRequest?.(index);
        try {
          return await sendTweet(
            client,
            chunk,
            index === 0 ? mediaData : [],
            previousTweetId ?? inReplyTo,
            index === 0 ? mediaIds : undefined,
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

  const isWhitespace = (unit: string | undefined) =>
    unit !== undefined && /^\s+$/u.test(unit);

  const chunks: string[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let chunk = "";
    for (; end < units.length; end += 1) {
      const unit = units[end] as string;
      if (countTwitterWeightedLength(unit) > maxLength) {
        throw new ElizaError(
          "An indivisible X post token exceeds the provider limit",
          {
            code: "X_POST_TOKEN_TOO_LONG",
            context: { maxLength },
          },
        );
      }
      const candidate = `${chunk}${unit}`;
      if (chunk && countTwitterWeightedLength(candidate) > maxLength) break;
      chunk = candidate;
    }

    // Like splitSlackText: end the post after the last whitespace when that
    // keeps it over half full, so words are not cut. The whitespace stays on
    // this post, so joining the posts still gives back the original text.
    if (end < units.length && !isWhitespace(units[end])) {
      let cut = end - 1;
      while (cut > start && !isWhitespace(units[cut])) cut -= 1;
      if (cut > start) {
        const kept = units.slice(start, cut + 1).join("");
        if (
          /\S/u.test(kept) &&
          countTwitterWeightedLength(kept) > maxLength / 2
        ) {
          chunk = kept;
          end = cut + 1;
        }
      }
    }

    chunks.push(chunk);
    start = end;
  }
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
