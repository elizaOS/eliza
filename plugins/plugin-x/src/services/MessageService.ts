import { createUniqueUuid, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
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

  private errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private extractRestId(result: unknown): string | undefined {
    const r = result as {
      rest_id?: unknown;
      data?: {
        create_tweet?: { tweet_results?: { result?: { rest_id?: unknown } } };
        data?: {
          create_tweet?: { tweet_results?: { result?: { rest_id?: unknown } } };
        };
      };
    } | null;
    const candidate =
      r?.rest_id ??
      r?.data?.create_tweet?.tweet_results?.result?.rest_id ??
      r?.data?.data?.create_tweet?.tweet_results?.result?.rest_id;
    return typeof candidate === "string" ? candidate : undefined;
  }

  private async extractResultId(result: unknown): Promise<string | undefined> {
    const r = result as {
      id?: unknown;
      data?: { id?: unknown; data?: { id?: unknown } };
      json?: unknown;
    } | null;
    const direct = r?.id ?? r?.data?.id ?? r?.data?.data?.id;
    if (typeof direct === "string") return direct;
    const restId = this.extractRestId(result);
    if (restId) return restId;

    if (r && typeof r.json === "function") {
      try {
        const body = (await (r.json as () => Promise<unknown>)()) as {
          id?: unknown;
          data?: { id?: unknown; data?: { id?: unknown } };
        } | null;
        const viaBody = body?.id ?? body?.data?.id ?? body?.data?.data?.id;
        if (typeof viaBody === "string") return viaBody;
        return this.extractRestId(body);
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
        .filter((tweet) => typeof tweet.id === "string")
        .filter((tweet) => {
          const conversationId = tweet.conversationId ?? tweet.id;
          if (!conversationId) return false;
          // Filter by room ID if specified
          if (options.roomId) {
            const tweetRoomId = createUniqueUuid(
              this.client.runtime,
              conversationId,
            );
            return tweetRoomId === options.roomId;
          }
          return true;
        })
        .map((tweet) => {
          const tweetId = tweet.id as string;
          const conversationId = tweet.conversationId ?? tweetId;
          return {
            id: tweetId,
            agentId: this.client.runtime.agentId,
            roomId: createUniqueUuid(this.client.runtime, conversationId),
            userId: tweet.userId ?? "",
            username: tweet.username ?? "",
            text: tweet.text ?? "",
            type: tweet.inReplyToStatusId
              ? MessageType.REPLY
              : MessageType.MENTION,
            timestamp: getEpochMs(tweet.timestamp),
            inReplyTo: tweet.inReplyToStatusId,
            metadata: {
              tweetId,
              permanentUrl: tweet.permanentUrl,
            },
          };
        });

      return messages;
    } catch (error) {
      logger.error("Error fetching messages:", this.errorDetail(error));
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
          options.text,
        );
      } else {
        // Send tweet (reply, mention, or regular post)
        result = await this.client.twitterClient.sendTweet(
          options.text,
          options.replyToId,
        );
      }

      const extractedId = await this.extractResultId(result);
      const resultId = (result as { id?: unknown } | null)?.id;
      const messageId =
        extractedId ?? (typeof resultId === "string" ? resultId : "");

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
        metadata: {
          ...options.metadata,
          result,
        },
      };

      return message;
    } catch (error) {
      logger.error("Error sending message:", this.errorDetail(error));
      throw error;
    }
  }

  async deleteMessage(messageId: string, _agentId: UUID): Promise<void> {
    try {
      await this.client.twitterClient.deleteTweet(messageId);
    } catch (error) {
      logger.error("Error deleting message:", this.errorDetail(error));
      throw error;
    }
  }

  async getMessage(messageId: string, agentId: UUID): Promise<Message | null> {
    try {
      const tweet = await this.client.twitterClient.getTweet(messageId);

      if (!tweet?.id) return null;
      const conversationId = tweet.conversationId ?? tweet.id;

      const message: Message = {
        id: tweet.id,
        agentId: agentId,
        roomId: createUniqueUuid(this.client.runtime, conversationId),
        userId: tweet.userId ?? "",
        username: tweet.username ?? "",
        text: tweet.text ?? "",
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
      logger.error("Error fetching message:", this.errorDetail(error));
      return null;
    }
  }

  async markAsRead(_messageIds: string[], _agentId: UUID): Promise<void> {
    // Twitter doesn't have a read/unread concept for tweets
    // This could be implemented by storing read status in local cache
    logger.debug("Marking messages as read is not implemented for Twitter");
  }
}
