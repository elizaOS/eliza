import { createUniqueUuid, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { extractIdFromResult, extractRestId, isResponseLike, type TweetResponse } from "../types";
import { getEpochMs } from "../utils/time";
import {
  type GetMessagesOptions,
  type IMessageService,
  type Message,
  MessageType,
  type SendMessageOptions,
} from "./IMessageService";

export class TwitterMessageService implements IMessageService {
  constructor(private client: ClientBase) {}

  /**
   * Extract ID from various Twitter API response shapes
   */
  private async extractResultId(result: TweetResponse | unknown): Promise<string | undefined> {
    // First try direct extraction using type-safe utility
    const directId = extractIdFromResult(result);
    if (directId) return directId;

    // Check for rest_id
    const restId = extractRestId(result);
    if (restId) return restId;

    // Handle Response-like objects
    if (isResponseLike(result) && result.json && typeof result.json === "function") {
      try {
        const body = await result.json();
        const bodyId = extractIdFromResult(body);
        if (bodyId) return bodyId;

        const bodyRestId = extractRestId(body);
        if (bodyRestId) return bodyRestId;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  async getMessages(options: GetMessagesOptions): Promise<Message[]> {
    try {
      // Twitter doesn't have a direct way to get messages by room ID
      // We'll need to use search to find related tweets/DMs
      const username = this.client.profile?.username;
      if (!username) {
        logger.error("No Twitter profile available");
        return [];
      }

      // Search for mentions and replies
      const searchResult = await this.client.fetchSearchTweets(
        `@${username}`,
        options.limit || 20,
        SearchMode.Latest
      );

      const messages: Message[] = searchResult.tweets
        .filter((tweet) => {
          // Filter by room ID if specified
          if (options.roomId && tweet.conversationId) {
            const tweetRoomId = createUniqueUuid(this.client.runtime, tweet.conversationId);
            return tweetRoomId === options.roomId;
          }
          return true;
        })
        .filter(
          (
            tweet
          ): tweet is typeof tweet & {
            id: string;
            userId: string;
            username: string;
            text: string;
            conversationId: string;
          } => !!(tweet.id && tweet.userId && tweet.username && tweet.text && tweet.conversationId)
        )
        .map((tweet) => ({
          id: tweet.id,
          agentId: this.client.runtime.agentId,
          roomId: createUniqueUuid(this.client.runtime, tweet.conversationId),
          userId: tweet.userId,
          username: tweet.username,
          text: tweet.text,
          type: tweet.inReplyToStatusId ? MessageType.REPLY : MessageType.MENTION,
          timestamp: getEpochMs(tweet.timestamp),
          inReplyTo: tweet.inReplyToStatusId,
          metadata: {
            tweetId: tweet.id,
            permanentUrl: tweet.permanentUrl,
          },
        }));

      return messages;
    } catch (error) {
      logger.error(
        "Error fetching messages:",
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<Message> {
    try {
      let result: unknown;

      if (options.type === MessageType.DIRECT_MESSAGE) {
        // Send direct message using the roomId as conversationId
        result = await this.client.twitterClient.sendDirectMessage(
          options.roomId.toString(),
          options.text
        );
      } else {
        // Send tweet (reply, mention, or regular post)
        result = await this.client.twitterClient.sendTweet(options.text, options.replyToId);
      }

      // Extract the message ID using type-safe utilities
      const extractedId = await this.extractResultId(result);
      const messageId = extractedId || "";

      if (!messageId) {
        logger.warn("Could not extract message ID from Twitter response");
      }

      const message: Message = {
        id: messageId,
        agentId: options.agentId,
        roomId: options.roomId,
        userId: this.client.profile?.id || "",
        username: this.client.profile?.username || "",
        text: options.text,
        type: options.type,
        timestamp: Date.now(),
        inReplyTo: options.replyToId,
        metadata: options.metadata,
      };

      return message;
    } catch (error) {
      logger.error(
        "Error sending message:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async deleteMessage(messageId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.deleteTweet(messageId);
    } catch (error) {
      logger.error(
        "Error deleting message:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async getMessage(messageId: string, agentId: UUID): Promise<Message | null> {
    try {
      const tweet = await this.client.twitterClient.getTweet(messageId);

      if (
        !tweet ||
        !tweet.id ||
        !tweet.userId ||
        !tweet.username ||
        !tweet.text ||
        !tweet.conversationId
      ) {
        return null;
      }

      const message: Message = {
        id: tweet.id,
        agentId: agentId,
        roomId: createUniqueUuid(this.client.runtime, tweet.conversationId),
        userId: tweet.userId,
        username: tweet.username,
        text: tweet.text,
        type: tweet.inReplyToStatusId ? MessageType.REPLY : MessageType.POST,
        timestamp: getEpochMs(tweet.timestamp),
        inReplyTo: tweet.inReplyToStatusId,
        metadata: {
          tweetId: tweet.id,
          permanentUrl: tweet.permanentUrl,
        },
      };

      return message;
    } catch (error) {
      logger.error(
        "Error fetching message:",
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  async markAsRead(_messageIds: string[], _agentId: UUID): Promise<void> {
    // Twitter doesn't have a read/unread concept for tweets
    // This could be implemented by storing read status in local cache
    logger.debug("Marking messages as read is not implemented for Twitter");
  }
}
