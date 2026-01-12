import { createUniqueUuid, logger, type UUID } from "@elizaos/core";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { extractIdFromResult, extractRestId, isResponseLike, type PostResponse } from "../types";
import { getEpochMs } from "../utils/time";
import {
  type GetMessagesOptions,
  type IMessageService,
  type Message,
  MessageType,
  type SendMessageOptions,
} from "./IMessageService";

export class XMessageService implements IMessageService {
  constructor(private client: ClientBase) {}

  private async extractResultId(result: PostResponse | unknown): Promise<string | undefined> {
    const directId = extractIdFromResult(result);
    if (directId) return directId;

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
      const username = this.client.profile?.username;
      if (!username) {
        logger.error("No X profile available");
        return [];
      }

      // Search for mentions and replies
      const searchResult = await this.client.fetchSearchPosts(
        `@${username}`,
        options.limit || 20,
        SearchMode.Latest
      );

      const messages: Message[] = searchResult.posts
        .filter((post) => {
          if (options.roomId && post.conversationId) {
            const postRoomId = createUniqueUuid(this.client.runtime, post.conversationId);
            return postRoomId === options.roomId;
          }
          return true;
        })
        .filter(
          (
            post
          ): post is typeof post & {
            id: string;
            userId: string;
            username: string;
            text: string;
            conversationId: string;
          } => !!(post.id && post.userId && post.username && post.text && post.conversationId)
        )
        .map((post) => ({
          id: post.id,
          agentId: this.client.runtime.agentId,
          roomId: createUniqueUuid(this.client.runtime, post.conversationId),
          userId: post.userId,
          username: post.username,
          text: post.text,
          type: post.inReplyToStatusId ? MessageType.REPLY : MessageType.MENTION,
          timestamp: getEpochMs(post.timestamp),
          inReplyTo: post.inReplyToStatusId,
          metadata: {
            postId: post.id,
            permanentUrl: post.permanentUrl,
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
        result = await this.client.xClient.sendDirectMessage(
          options.roomId.toString(),
          options.text
        );
      } else {
        result = await this.client.xClient.sendPost(options.text, options.replyToId);
      }

      const extractedId = await this.extractResultId(result);
      const messageId = extractedId || "";

      if (!messageId) {
        logger.warn("Could not extract message ID from X response");
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
      await this.client.xClient.deletePost(messageId);
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
      const post = await this.client.xClient.getPost(messageId);

      if (
        !post ||
        !post.id ||
        !post.userId ||
        !post.username ||
        !post.text ||
        !post.conversationId
      ) {
        return null;
      }

      const message: Message = {
        id: post.id,
        agentId: agentId,
        roomId: createUniqueUuid(this.client.runtime, post.conversationId),
        userId: post.userId,
        username: post.username,
        text: post.text,
        type: post.inReplyToStatusId ? MessageType.REPLY : MessageType.POST,
        timestamp: getEpochMs(post.timestamp),
        inReplyTo: post.inReplyToStatusId,
        metadata: {
          postId: post.id,
          permanentUrl: post.permanentUrl,
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
    logger.debug("Marking messages as read is not implemented for X");
  }
}
