import { type UUID, createUniqueUuid, logger } from "@elizaos/core";
import { getEpochMs } from "../utils/time";
import {
  type IMessageService,
  type Message,
  MessageType,
  type GetMessagesOptions,
  type SendMessageOptions,
} from "./IMessageService";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";

export class TwitterMessageService implements IMessageService {
  constructor(private client: ClientBase) {}

  private extractRestId(result: any): string | undefined {
    return (
      result?.rest_id ??
      result?.data?.create_tweet?.tweet_results?.result?.rest_id ??
      result?.data?.data?.create_tweet?.tweet_results?.result?.rest_id ??
      undefined
    );
  }

  private async extractResultId(result: any): Promise<string | undefined> {
    const direct =
      result?.id ?? result?.data?.id ?? result?.data?.data?.id ?? undefined;
    if (direct) return direct;
    const restId = this.extractRestId(result);
    if (restId) return restId;

    if (result?.json && typeof result.json === "function") {
      try {
        const body = await result.json();
        return (
          body?.id ??
          body?.data?.id ??
          body?.data?.data?.id ??
          this.extractRestId(body) ??
          undefined
        );
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
        SearchMode.Latest,
      );

      const messages: Message[] = searchResult.tweets
        .filter((tweet) => {
          // Filter by room ID if specified
          if (options.roomId) {
            const tweetRoomId = createUniqueUuid(
              this.client.runtime,
              tweet.conversationId,
            );
            return tweetRoomId === options.roomId;
          }
          return true;
        })
        .map((tweet) => ({
          id: tweet.id,
          agentId: this.client.runtime.agentId,
          roomId: createUniqueUuid(this.client.runtime, tweet.conversationId),
          userId: tweet.userId,
          username: tweet.username,
          text: tweet.text,
          type: tweet.inReplyToStatusId
            ? MessageType.REPLY
            : MessageType.MENTION,
          timestamp: getEpochMs(tweet.timestamp),
          inReplyTo: tweet.inReplyToStatusId,
          metadata: {
            tweetId: tweet.id,
            permanentUrl: tweet.permanentUrl,
          },
        }));

      return messages;
    } catch (error) {
      logger.error("Error fetching messages:", error);
      return [];
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<Message> {
    try {
      let result;

      if (options.type === MessageType.DIRECT_MESSAGE) {
        // Send direct message using the roomId as conversationId
        result = await this.client.twitterClient.sendDirectMessage(
          options.roomId.toString(),
          options.text,
        );
      } else {
        // Send tweet (reply, mention, or regular post)
        result = await this.client.twitterClient.sendTweet(
          options.text,
          options.replyToId,
        );
      }

      const message: Message = {
        id: (await this.extractResultId(result)) || (result?.id as any),
        agentId: options.agentId,
        roomId: options.roomId,
        userId: this.client.profile?.id || "",
        username: this.client.profile?.username || "",
        text: options.text,
        type: options.type,
        timestamp: Date.now(),
        inReplyTo: options.replyToId,
        metadata: {
          ...options.metadata,
          result,
        },
      };

      return message;
    } catch (error) {
      logger.error("Error sending message:", error);
      throw error;
    }
  }

  async deleteMessage(messageId: string, agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.deleteTweet(messageId);
    } catch (error) {
      logger.error("Error deleting message:", error);
      throw error;
    }
  }

  async getMessage(messageId: string, agentId: UUID): Promise<Message | null> {
    try {
      const tweet = await this.client.twitterClient.getTweet(messageId);

      if (!tweet) return null;

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
      logger.error("Error fetching message:", error);
      return null;
    }
  }

  async markAsRead(messageIds: string[], agentId: UUID): Promise<void> {
    // Twitter doesn't have a read/unread concept for tweets
    // This could be implemented by storing read status in local cache
    logger.debug("Marking messages as read is not implemented for Twitter");
  }

  /**
   * Extract tweet ID from a UUID that was created from a tweet ID
   */
  private extractTweetId(uuid: UUID): string {
    // This is a simple approach - in production you might want to store
    // the mapping between UUIDs and tweet IDs in a cache
    return uuid.toString();
  }
}
