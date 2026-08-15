/**
 * `TwitterMessageService` — the `IMessageService` implementation for X direct
 * messages, sending and listing DMs through `ClientBase`. Backs the message
 * connector handlers and the LifeOps DM adapter.
 */
import { createUniqueUuid, ElizaError, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { extractXWriteReceiptId } from "../utils/provider-receipt";
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

  async getMessages(options: GetMessagesOptions): Promise<Message[]> {
    try {
      return await this.client.withAuthenticatedSession(async ({ profile }) => {
        // Twitter doesn't have a direct way to get messages by room ID
        // We'll need to use search to find related tweets/DMs
        const searchResult = await this.client.fetchSearchTweets(
          `@${profile.username}`,
          options.limit || 20,
          SearchMode.Latest,
        );

        const messages: Message[] = searchResult.tweets.flatMap((tweet) => {
          // Normalize once per row; rows without a usable identity or timestamp
          // fail closed instead of surfacing as fresh messages (#18965).
          const timestamp = getEpochMs(tweet.timestamp);
          if (typeof tweet.id !== "string" || timestamp === undefined)
            return [];
          const tweetId = tweet.id;
          const conversationId = tweet.conversationId ?? tweetId;
          if (options.roomId) {
            const tweetRoomId = createUniqueUuid(
              this.client.runtime,
              conversationId,
            );
            if (tweetRoomId !== options.roomId) return [];
          }
          return [
            {
              id: tweetId,
              agentId: this.client.runtime.agentId,
              roomId: createUniqueUuid(this.client.runtime, conversationId),
              userId: tweet.userId ?? "",
              username: tweet.username ?? "",
              text: tweet.text ?? "",
              type: tweet.inReplyToStatusId
                ? MessageType.REPLY
                : MessageType.MENTION,
              timestamp,
              inReplyTo: tweet.inReplyToStatusId,
              metadata: {
                tweetId,
                permanentUrl: tweet.permanentUrl,
              },
            },
          ];
        });

        return messages;
      });
    } catch (error) {
      // error-policy:J7 Report the connector failure to the agent, then keep it
      // distinct from a legitimately empty inbox.
      this.client.runtime.reportError("XMessageService.getMessages", error);
      throw error;
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<Message> {
    return this.client.withAuthenticatedSession(async (session) => {
      const { profile } = session;
      try {
        let result: unknown;
        if (!this.client.isAuthenticatedSessionCurrent(session)) {
          throw new ElizaError("X credentials rotated before message egress", {
            code: "X_AUTH_SESSION_ROTATED",
          });
        }

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

        const extractedId = await extractXWriteReceiptId(result);
        if (!extractedId) {
          throw new ElizaError(
            "X accepted the message but returned no usable receipt; do not retry blindly",
            {
              code: "X_MESSAGE_RECEIPT_INDETERMINATE",
              context: {
                accountId: this.client.accountId,
                providerAccepted: true,
                retrySafe: false,
              },
            },
          );
        }

        const message: Message = {
          id: extractedId,
          agentId: options.agentId,
          roomId: options.roomId,
          userId: profile.id,
          username: profile.username,
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
    });
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

      // Fail closed on a present-but-unusable timestamp (#18965).
      const timestamp = getEpochMs(tweet.timestamp);
      if (timestamp === undefined) return null;

      const message: Message = {
        id: tweet.id,
        agentId: agentId,
        roomId: createUniqueUuid(this.client.runtime, conversationId),
        userId: tweet.userId ?? "",
        username: tweet.username ?? "",
        text: tweet.text ?? "",
        type: tweet.inReplyToStatusId ? MessageType.REPLY : MessageType.POST,
        timestamp,
        inReplyTo: tweet.inReplyToStatusId,
        metadata: {
          tweetId: tweet.id,
          permanentUrl: tweet.permanentUrl,
        },
      };

      return message;
    } catch (error) {
      // error-policy:J7 Report the connector failure to the agent, then keep it
      // distinct from the legitimate null returned for a missing message.
      this.client.runtime.reportError("XMessageService.getMessage", error);
      throw error;
    }
  }

  async markAsRead(_messageIds: string[], _agentId: UUID): Promise<void> {
    // Twitter doesn't have a read/unread concept for tweets
    logger.debug("Marking messages as read is unsupported for Twitter");
  }
}
