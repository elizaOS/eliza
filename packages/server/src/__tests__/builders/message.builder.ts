/**
 * MessageBuilder - Type-safe test data builder for Message objects
 *
 * Provides a fluent API for creating valid message instances in tests.
 * Uses the Builder pattern to ensure type safety and provide sensible defaults.
 *
 * @example
 * ```typescript
 * const message = new MessageBuilder()
 *   .withChannelId(channelId)
 *   .withAuthorId(userId)
 *   .withContent('Hello world')
 *   .build();
 * ```
 */

import type { UUID } from '@elizaos/core';
import type { CentralRootMessage } from '../../types/server';

/**
 * Message input type for createMessage API
 */
export type MessageInput = Omit<CentralRootMessage, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Builder class for creating Message test data
 */
export class MessageBuilder {
  private message: Partial<MessageInput> = {
    metadata: {},
  };

  /**
   * Set the channel ID
   */
  withChannelId(channelId: UUID): this {
    this.message.channelId = channelId;
    return this;
  }

  /**
   * Set the author ID
   */
  withAuthorId(authorId: UUID): this {
    this.message.authorId = authorId;
    return this;
  }

  /**
   * Set the message content
   */
  withContent(content: string): this {
    this.message.content = content;
    if (!this.message.rawMessage) {
      this.message.rawMessage = content; // Auto-set rawMessage if not already set
    }
    return this;
  }

  /**
   * Set the raw message (original source message)
   */
  withRawMessage(rawMessage: string): this {
    this.message.rawMessage = rawMessage;
    return this;
  }

  /**
   * Set the source ID (unique identifier from source system)
   */
  withSourceId(sourceId: string): this {
    this.message.sourceId = sourceId;
    return this;
  }

  /**
   * Set the source type (e.g., 'discord', 'telegram', 'test')
   */
  withSourceType(sourceType: string): this {
    this.message.sourceType = sourceType;
    return this;
  }

  /**
   * Set message metadata
   */
  withMetadata(metadata: Record<string, any>): this {
    this.message.metadata = {
      ...this.message.metadata,
      ...metadata,
    };
    return this;
  }

  /**
   * Add a single metadata field
   */
  withMetadataField(key: string, value: any): this {
    if (!this.message.metadata) {
      this.message.metadata = {};
    }
    this.message.metadata[key] = value;
    return this;
  }

  /**
   * Set the message this is replying to
   */
  inReplyTo(messageId: UUID): this {
    this.message.inReplyToRootMessageId = messageId;
    return this;
  }

  /**
   * Create a simple test message with sensible defaults
   */
  asSimpleMessage(channelId: UUID, authorId: UUID): this {
    return this.withChannelId(channelId)
      .withAuthorId(authorId)
      .withContent('Test message')
      .withRawMessage('Test message')
      .withSourceId(`simple-${Date.now()}`)
      .withSourceType('test');
  }

  /**
   * Create a reply message
   */
  asReplyMessage(channelId: UUID, authorId: UUID, inReplyToId: UUID): this {
    return this.withChannelId(channelId)
      .withAuthorId(authorId)
      .withContent('Reply message')
      .withRawMessage('Reply message')
      .withSourceId(`reply-${Date.now()}`)
      .withSourceType('test')
      .inReplyTo(inReplyToId);
  }

  /**
   * Create a message from a specific client type
   */
  fromClient(
    clientType: 'discord' | 'telegram' | 'twitter',
    channelId: UUID,
    authorId: UUID
  ): this {
    const clientMessages = {
      discord: 'Message from Discord',
      telegram: 'Message from Telegram',
      twitter: 'Message from Twitter',
    };

    return this.withChannelId(channelId)
      .withAuthorId(authorId)
      .withContent(clientMessages[clientType])
      .withRawMessage(clientMessages[clientType])
      .withSourceId(`${clientType}-${Date.now()}`)
      .withSourceType(clientType);
  }

  /**
   * Create a message with rich metadata
   */
  withRichMetadata(channelId: UUID, authorId: UUID): this {
    return this.withChannelId(channelId)
      .withAuthorId(authorId)
      .withContent('Message with metadata')
      .withRawMessage('Message with metadata')
      .withSourceId(`rich-${Date.now()}`)
      .withSourceType('test')
      .withMetadata({
        timestamp: new Date().toISOString(),
        attachments: [],
        mentions: [],
        reactions: [],
      });
  }

  /**
   * Build the final MessageInput object
   *
   * @throws Error if required fields are missing
   */
  build(): Omit<CentralRootMessage, 'id' | 'createdAt' | 'updatedAt'> {
    if (!this.message.channelId) {
      throw new Error(
        'Message must have a channelId. Use .withChannelId() or a preset like .asSimpleMessage()'
      );
    }

    if (!this.message.authorId) {
      throw new Error(
        'Message must have an authorId. Use .withAuthorId() or a preset like .asSimpleMessage()'
      );
    }

    if (!this.message.content) {
      throw new Error(
        'Message must have content. Use .withContent() or a preset like .asSimpleMessage()'
      );
    }

    if (!this.message.rawMessage) {
      this.message.rawMessage = this.message.content;
    }

    if (!this.message.sourceId) {
      this.message.sourceId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }

    if (!this.message.sourceType) {
      this.message.sourceType = 'test';
    }

    // Explicitly set optional fields to null if undefined
    // This prevents Drizzle from using SQL 'default' keyword
    if (this.message.inReplyToRootMessageId === undefined) {
      // inReplyToRootMessageId is UUID | undefined, but we need null for database
      this.message.inReplyToRootMessageId = null as UUID | null;
    }

    // Type assertion ensures required fields are present after validation
    // After validation, we know these fields are defined
    return {
      channelId: this.message.channelId!,
      authorId: this.message.authorId!,
      content: this.message.content!,
      rawMessage: this.message.rawMessage,
      sourceId: this.message.sourceId,
      sourceType: this.message.sourceType,
      ...(this.message.inReplyToRootMessageId !== undefined && {
        inReplyToRootMessageId: this.message.inReplyToRootMessageId,
      }),
      ...(this.message.metadata && { metadata: this.message.metadata }),
    };
  }

  /**
   * Build multiple messages with incremental content
   *
   * @param count - Number of messages to create
   * @param channelId - Channel ID for all messages
   * @param authorId - Author ID for all messages (or function to generate per index)
   * @returns Array of MessageInput objects
   *
   * @example
   * ```typescript
   * // Same author
   * const messages = new MessageBuilder()
   *   .buildMany(5, channelId, userId);
   * // Creates: "Message 1", "Message 2", etc.
   *
   * // Different authors
   * const messages = new MessageBuilder()
   *   .buildMany(5, channelId, (i) => stringToUuid(`user-${i}`));
   * ```
   */
  buildMany(
    count: number,
    channelId: UUID,
    authorId: UUID | ((index: number) => UUID)
  ): MessageInput[] {
    const messages: MessageInput[] = [];

    for (let i = 1; i <= count; i++) {
      const builder = new MessageBuilder();
      // Copy current state (excluding channel/author/content)
      if (this.message.sourceType) {
        builder.withSourceType(this.message.sourceType);
      }
      if (this.message.metadata) {
        builder.withMetadata(this.message.metadata);
      }

      // Set incremental values
      const author = typeof authorId === 'function' ? authorId(i) : authorId;
      builder
        .withChannelId(channelId)
        .withAuthorId(author)
        .withContent(`Message ${i}`)
        .withRawMessage(`Message ${i}`)
        .withSourceId(`batch-${Date.now()}-${i}`);

      messages.push(builder.build());
    }

    return messages;
  }
}
