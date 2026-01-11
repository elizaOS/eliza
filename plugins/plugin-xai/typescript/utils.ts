import fs from "node:fs";
import path from "node:path";
import type { Media } from "@elizaos/core";
import {
  type Content,
  createUniqueUuid,
  logger,
  type Memory,
  truncateToCompleteSentence,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { Post } from "./client";
import { TWEET_MAX_LENGTH } from "./constants";
import type { ActionResponse, MediaData, PostResponse } from "./types";

export const wait = (minTime = 1000, maxTime = 3000) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export const isValidPost = (post: Post): boolean => {
  // Filter out posts with too many hashtags, @s, or $ signs, probably spam or garbage
  const hashtagCount = (post.text?.match(/#/g) || []).length;
  const atCount = (post.text?.match(/@/g) || []).length;
  const dollarSignCount = (post.text?.match(/\$/g) || []).length;
  const totalCount = hashtagCount + atCount + dollarSignCount;

  return hashtagCount <= 1 && atCount <= 2 && dollarSignCount <= 1 && totalCount <= 3;
};

/**
 * Fetches media data from a list of attachments, supporting both HTTP URLs and local file paths.
 *
 * @param attachments Array of Media objects containing URLs or file paths to fetch media from
 * @returns Promise that resolves with an array of MediaData objects containing the fetched media data and content type
 */
export async function fetchMediaData(attachments: Media[]): Promise<MediaData[]> {
  return Promise.all(
    attachments.map(async (attachment: Media) => {
      if (/^(http|https):\/\//.test(attachment.url)) {
        // Handle HTTP URLs
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${attachment.url}`);
        }
        const mediaBuffer = Buffer.from(await response.arrayBuffer());
        const mediaType = attachment.contentType || "image/png";
        return { data: mediaBuffer, type: mediaType };
      }
      if (fs.existsSync(attachment.url)) {
        // Handle local file paths
        const mediaBuffer = await fs.promises.readFile(path.resolve(attachment.url));
        const mediaType = attachment.contentType || "image/png";
        return { data: mediaBuffer, type: mediaType };
      }
      throw new Error(`File not found: ${attachment.url}. Make sure the path is correct.`);
    })
  );
}

/**
 * Handles sending a note post with optional media data.
 *
 * @param {ClientBase} client - The client object used for sending the note post.
 * @param {string} content - The content of the note post.
 * @param {string} [postId] - Optional Post ID to reply to.
 * @param {MediaData[]} [mediaData] - Optional media data to attach to the note post.
 * @returns {Promise<Object>} - The result of the note post operation.
 * @throws {Error} - If the note post operation fails.
 */
async function _handleNotePost(
  client: ClientBase,
  content: string,
  postId?: string,
  mediaData?: MediaData[]
) {
  // X API v2 handles long posts automatically
  // Just use the regular sendPost method
  const convertedMediaData = mediaData?.map((m) => ({
    data: Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data),
    mediaType: m.type,
  }));
  const result = await client.xClient.sendPost(content, postId, convertedMediaData);

  // Check if the result was successful
  if (!result || !result.ok) {
    // Post failed. Falling back to truncated Post.
    const truncateContent = truncateToCompleteSentence(content, TWEET_MAX_LENGTH);
    return await sendStandardPost(client, truncateContent, postId);
  }

  // Return the result directly
  return result;
}

/**
 * Send a standard post through the client
 */
export async function sendStandardPost(
  client: ClientBase,
  content: string,
  postId?: string,
  mediaData?: MediaData[]
) {
  const convertedMediaData = mediaData?.map((m) => ({
    data: Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data),
    mediaType: m.type,
  }));
  const standardPostResult = await client.xClient.sendPost(content, postId, convertedMediaData);

  // The result is already the response object
  return standardPostResult;
}

export async function sendPost(
  client: ClientBase,
  text: string,
  mediaData: MediaData[] = [],
  postToReplyTo?: string
): Promise<PostResponse | null> {
  const isNotePost = text.length > TWEET_MAX_LENGTH;
  const postText = isNotePost ? truncateToCompleteSentence(text, TWEET_MAX_LENGTH) : text;

  let result: { data?: { data?: { id?: string } }; id?: string } | undefined;

  try {
    const convertedMediaData = mediaData.map((m) => ({
      data: Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data),
      mediaType: m.type,
    }));
    result = await client.xClient.sendPost(postText, postToReplyTo, convertedMediaData);
    logger.log("Successfully posted Post");
  } catch (error) {
    logger.error("Error posting Post:", error instanceof Error ? error.message : String(error));
    throw error;
  }

  try {
    // The result from sendPost should have the post data
    const postData = result?.data || result;

    // Extract the post ID and other data - parse to match PostResponse structure
    const rawResult = (postData?.data || postData) as
      | { id?: string; text?: string; data?: { id?: string; data?: { id?: string } } }
      | undefined;

    // if we have a response
    const postId = rawResult && ("id" in rawResult ? rawResult.id : rawResult.data?.id);
    if (postId) {
      if (client.lastCheckedPostId && client.lastCheckedPostId < BigInt(postId)) {
        client.lastCheckedPostId = BigInt(postId);
      } else if (!client.lastCheckedPostId) {
        client.lastCheckedPostId = BigInt(postId);
      }
      await client.cacheLatestCheckedPostId();

      // Cache the post - ensure it has all required fields
      const postText = rawResult && ("text" in rawResult ? rawResult.text : undefined);
      if (postId && postText) {
        await client.cachePost({ id: postId, text: postText, ...rawResult } as Post);
      }

      logger.log("Successfully posted a post", postId);

      // Return as PostResponse format
      const postResult: PostResponse = {
        id: rawResult.id,
        data: rawResult.data,
      };
      return postResult;
    }
  } catch (error) {
    logger.error(
      "Error parsing post response:",
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }

  logger.error("No valid response from X API");
  throw new Error("Failed to send post - no valid response");
}

/**
 * Sends a post on X using the given client.
 *
 * @param {ClientBase} client The client used to send the post.
 * @param {Content} content The content of the post.
 * @param {UUID} roomId The ID of the room where the post will be sent.
 * @param {string} xUsername The X username of the sender.
 * @param {string} inReplyTo The ID of the post to which the new post will reply.
 * @returns {Promise<Memory[]>} An array of memories representing the sent posts.
 */
export async function sendChunkedPost(
  client: ClientBase,
  content: Content,
  roomId: UUID,
  xUsername: string,
  inReplyTo: string
): Promise<Memory[]> {
  const messages: Memory[] = [];
  if (!content.text) {
    logger.warn("Cannot split post content: text is undefined");
    return [];
  }
  const chunks = splitPostContent(content.text, TWEET_MAX_LENGTH);

  let previousPostId = inReplyTo;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const _isLastChunk = i === chunks.length - 1;

    // Add the post number to the beginning of each chunk
    const postContent = `${chunk}`;

    logger.debug(`Sending post ${i + 1}/${chunks.length}: ${postContent}`);

    try {
      // Convert Media[] to MediaData[] if needed
      let mediaData: MediaData[] = [];
      if (content.attachments && content.attachments.length > 0) {
        mediaData = await fetchMediaData(content.attachments);
      }

      const result = await sendPost(client, postContent, mediaData, previousPostId);

      if (!result) {
        throw new Error("Failed to send post - no result returned");
      }

      // Extract post ID from the PostResponse structure
      const postId = result.id || result.data?.id || result.data?.data?.id;

      // if we have a response
      if (postId) {
        const permanentUrl = `https://x.com/${xUsername}/status/${postId}`;

        const memory: Memory = {
          id: createUniqueUuid(client.runtime, postId),
          entityId: client.runtime.agentId,
          content: {
            text: chunk,
            url: permanentUrl,
            source: "x",
          },
          agentId: client.runtime.agentId,
          roomId,
          createdAt: Date.now(),
        };

        messages.push(memory);
        previousPostId = postId;
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error sending chunk ${i + 1}:`, err.message);
      throw err;
    }
  }

  return messages;
}

/**
 * Splits the given content into individual posts based on the maximum length allowed for a post.
 * @param {string} content - The content to split into posts.
 * @param {number} maxLength - The maximum length allowed for a single post.
 * @returns {string[]} An array of strings representing individual posts.
 */
function splitPostContent(content: string, maxLength: number): string[] {
  const paragraphs = content.split("\n\n").map((p) => p.trim());
  const posts: string[] = [];
  let currentPost = "";

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;

    if (`${currentPost}\n\n${paragraph}`.trim().length <= maxLength) {
      if (currentPost) {
        currentPost += `\n\n${paragraph}`;
      } else {
        currentPost = paragraph;
      }
    } else {
      if (currentPost) {
        posts.push(currentPost.trim());
      }
      if (paragraph.length <= maxLength) {
        currentPost = paragraph;
      } else {
        // Split long paragraph into smaller chunks
        const chunks = splitParagraph(paragraph, maxLength);
        posts.push(...chunks.slice(0, -1));
        currentPost = chunks[chunks.length - 1];
      }
    }
  }

  if (currentPost) {
    posts.push(currentPost.trim());
  }

  return posts;
}

/**
 * Extracts URLs from a given paragraph and replaces them with placeholders.
 *
 * @param {string} paragraph - The paragraph containing URLs that need to be replaced
 * @returns {Object} An object containing the updated text with placeholders and a map of placeholders to original URLs
 */
function extractUrls(paragraph: string): {
  textWithPlaceholders: string;
  placeholderMap: Map<string, string>;
} {
  // replace https urls with placeholder
  const urlRegex = /https?:\/\/[^\s]+/g;
  const placeholderMap = new Map<string, string>();

  let urlIndex = 0;
  const textWithPlaceholders = paragraph.replace(urlRegex, (match) => {
    // x url would be considered as 23 characters
    // <<URL_CONSIDERER_23_1>> is also 23 characters
    const placeholder = `<<URL_CONSIDERER_23_${urlIndex}>>`; // Placeholder without . ? ! etc
    placeholderMap.set(placeholder, match);
    urlIndex++;
    return placeholder;
  });

  return { textWithPlaceholders, placeholderMap };
}

/**
 * Splits a given text into chunks based on the specified maximum length while preserving sentence boundaries.
 *
 * @param {string} text - The text to be split into chunks
 * @param {number} maxLength - The maximum length each chunk should not exceed
 *
 * @returns {string[]} An array of chunks where each chunk is within the specified maximum length
 */
function splitSentencesAndWords(text: string, maxLength: number): string[] {
  // Split by periods, question marks and exclamation marks
  // Note that URLs in text have been replaced with `<<URL_xxx>>` and won't be split by dots
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if (`${currentChunk} ${sentence}`.trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += ` ${sentence}`;
      } else {
        currentChunk = sentence;
      }
    } else {
      // Can't fit more, push currentChunk to results
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }

      // If current sentence itself is less than or equal to maxLength
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        // Need to split sentence by spaces
        const words = sentence.split(" ");
        currentChunk = "";
        for (const word of words) {
          if (`${currentChunk} ${word}`.trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += ` ${word}`;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }

  // Handle remaining content
  if (currentChunk) {
    chunks.push(currentChunk.trim());
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
 * Restores the original URLs in the chunks by replacing placeholder URLs.
 *
 * @param {string[]} chunks - Array of strings representing chunks of text containing placeholder URLs.
 * @param {Map<string, string>} placeholderMap - Map with placeholder URLs as keys and original URLs as values.
 * @returns {string[]} - Array of strings with original URLs restored in each chunk.
 */
function restoreUrls(chunks: string[], placeholderMap: Map<string, string>): string[] {
  return chunks.map((chunk) => {
    // Replace all <<URL_CONSIDERER_23_>> in chunk back to original URLs using regex
    return chunk.replace(/<<URL_CONSIDERER_23_(\d+)>>/g, (match) => {
      const original = placeholderMap.get(match);
      return original || match; // Return placeholder if not found (theoretically won't happen)
    });
  });
}

/**
 * Splits a paragraph into chunks of text with a maximum length, while preserving URLs.
 *
 * @param {string} paragraph - The paragraph to split.
 * @param {number} maxLength - The maximum length of each chunk.
 * @returns {string[]} An array of strings representing the splitted chunks of text.
 */
function splitParagraph(paragraph: string, maxLength: number): string[] {
  // 1) Extract URLs and replace with placeholders
  const { textWithPlaceholders, placeholderMap } = extractUrls(paragraph);

  // 2) Use first section's logic to split by sentences first, then do secondary split
  const splittedChunks = splitSentencesAndWords(textWithPlaceholders, maxLength);

  // 3) Replace placeholders back to original URLs
  const restoredChunks = restoreUrls(splittedChunks, placeholderMap);

  return restoredChunks;
}

/**
 * Parses the action response from the given text.
 *
 * @param {string} text - The text to parse actions from.
 * @returns {{ actions: ActionResponse }} The parsed actions with boolean values indicating if each action is present in the text.
 */
export const parseActionResponseFromText = (text: string): { actions: ActionResponse } => {
  const actions: ActionResponse = {
    text: "",
    actions: [],
    like: false,
    repost: false,
    quote: false,
    reply: false,
  };

  // Regex patterns
  const likePattern = /\[LIKE\]/i;
  const repostPattern = /\[REPOST\]|\[RETWEET\]/i; // Support both for backward compatibility
  const quotePattern = /\[QUOTE\]/i;
  const replyPattern = /\[REPLY\]/i;

  // Check with regex
  actions.like = likePattern.test(text);
  actions.repost = repostPattern.test(text);
  actions.quote = quotePattern.test(text);
  actions.reply = replyPattern.test(text);

  // Also do line by line parsing as backup
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[LIKE]") actions.like = true;
    if (trimmed === "[REPOST]" || trimmed === "[RETWEET]") actions.repost = true; // Support both
    if (trimmed === "[QUOTE]") actions.quote = true;
    if (trimmed === "[REPLY]") actions.reply = true;
  }

  return { actions };
};

// Export error handler utilities
export * from "./utils/error-handler";
