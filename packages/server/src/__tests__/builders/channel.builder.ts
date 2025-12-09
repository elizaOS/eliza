/**
 * ChannelBuilder - Type-safe test data builder for Channel objects
 *
 * Provides a fluent API for creating valid channel instances in tests.
 * Uses the Builder pattern to ensure type safety and provide sensible defaults.
 *
 * @example
 * ```typescript
 * const channel = new ChannelBuilder()
 *   .withName('Test Channel')
 *   .withType(ChannelType.GROUP)
 *   .withServerId(serverId)
 *   .build();
 * ```
 */

import type { UUID } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';
import type { MessageChannel } from '../../types/server';

/**
 * Channel creation input type
 */
export type ChannelInput = Omit<MessageChannel, 'id' | 'createdAt' | 'updatedAt'> & { id?: UUID };

/**
 * Builder class for creating Channel test data
 */
export class ChannelBuilder {
  private channel: Partial<ChannelInput> = {
    metadata: {},
  };
  private participants: UUID[] = [];

  /**
   * Set the channel ID (optional - server will generate if not provided)
   */
  withId(id: UUID): this {
    this.channel.id = id;
    return this;
  }

  /**
   * Set the channel name
   */
  withName(name: string): this {
    this.channel.name = name;
    return this;
  }

  /**
   * Set the channel type
   */
  withType(type: ChannelType): this {
    this.channel.type = type;
    return this;
  }

  /**
   * Set the message server ID
   */
  withServerId(serverId: UUID): this {
    this.channel.messageServerId = serverId;
    return this;
  }

  /**
   * Set channel metadata
   */
  withMetadata(metadata: Record<string, any>): this {
    this.channel.metadata = {
      ...this.channel.metadata,
      ...metadata,
    };
    return this;
  }

  /**
   * Add a single metadata field
   */
  withMetadataField(key: string, value: any): this {
    if (!this.channel.metadata) {
      this.channel.metadata = {};
    }
    this.channel.metadata[key] = value;
    return this;
  }

  /**
   * Set initial participants (for createChannel API)
   */
  withParticipants(participants: UUID[]): this {
    this.participants = participants;
    return this;
  }

  /**
   * Add a participant
   */
  addParticipant(participantId: UUID): this {
    if (!this.participants.includes(participantId)) {
      this.participants.push(participantId);
    }
    return this;
  }

  /**
   * Create a simple group channel
   */
  asGroupChannel(name: string, serverId: UUID): this {
    return this.withName(name).withType(ChannelType.GROUP).withServerId(serverId).withMetadata({});
  }

  /**
   * Create a DM channel between two users
   */
  asDMChannel(user1: UUID, user2: UUID, serverId: UUID): this {
    return this.withName(`DM: ${user1.slice(0, 8)}...${user2.slice(0, 8)}`)
      .withType(ChannelType.DM)
      .withServerId(serverId)
      .withParticipants([user1, user2])
      .withMetadata({});
  }

  /**
   * Create a test channel with default settings
   */
  asTestChannel(serverId: UUID): this {
    return this.withName('Test Channel')
      .withType(ChannelType.GROUP)
      .withServerId(serverId)
      .withMetadata({ purpose: 'testing' });
  }

  /**
   * Create a channel for integration tests
   */
  asIntegrationTestChannel(serverId: UUID, testName: string): this {
    return this.withName(`Integration Test: ${testName}`)
      .withType(ChannelType.GROUP)
      .withServerId(serverId)
      .withMetadata({
        test: testName,
        timestamp: new Date().toISOString(),
      });
  }

  /**
   * Create a channel with participants
   */
  withTestParticipants(serverId: UUID, participantIds: UUID[]): this {
    return this.withName('Test Channel with Participants')
      .withType(ChannelType.GROUP)
      .withServerId(serverId)
      .withParticipants(participantIds)
      .withMetadata({});
  }

  /**
   * Get the participants list
   */
  getParticipants(): UUID[] {
    return this.participants;
  }

  /**
   * Build the final ChannelInput object
   *
   * @throws Error if required fields are missing
   */
  build(): ChannelInput {
    if (!this.channel.name) {
      throw new Error(
        'Channel must have a name. Use .withName() or a preset like .asTestChannel()'
      );
    }

    if (!this.channel.type) {
      throw new Error(
        'Channel must have a type. Use .withType() or a preset like .asTestChannel()'
      );
    }

    if (!this.channel.messageServerId) {
      throw new Error(
        'Channel must have a messageServerId. Use .withServerId() or a preset like .asTestChannel()'
      );
    }

    if (!this.channel.metadata) {
      this.channel.metadata = {};
    }

    // Type assertion ensures required fields are present after validation
    return {
      name: this.channel.name,
      type: this.channel.type,
      messageServerId: this.channel.messageServerId,
      metadata: this.channel.metadata,
      ...(this.channel.id && { id: this.channel.id }),
      ...(this.channel.sourceType && { sourceType: this.channel.sourceType }),
      ...(this.channel.sourceId && { sourceId: this.channel.sourceId }),
      ...(this.channel.topic && { topic: this.channel.topic }),
    } as ChannelInput;
  }

  /**
   * Build with participants - returns both channel input and participant list
   *
   * @returns Object with channel input and participants array
   */
  buildWithParticipants(): { channel: ChannelInput; participants: UUID[] } {
    return {
      channel: this.build(),
      participants: this.participants,
    };
  }

  /**
   * Build multiple channels with incremental names
   *
   * @param count - Number of channels to create
   * @param serverId - Server ID for all channels
   * @param prefix - Prefix for channel names
   * @returns Array of ChannelInput objects
   *
   * @example
   * ```typescript
   * const channels = new ChannelBuilder()
   *   .asGroupChannel('Base', serverId)
   *   .buildMany(3, serverId, 'Channel');
   * // Creates: "Channel 1", "Channel 2", "Channel 3"
   * ```
   */
  buildMany(count: number, serverId: UUID, prefix = 'Channel'): ChannelInput[] {
    const channels: ChannelInput[] = [];

    for (let i = 1; i <= count; i++) {
      const builder = new ChannelBuilder();
      // Copy current state (default to GROUP type if not set)
      builder.withType(this.channel.type || ChannelType.GROUP);
      if (this.channel.metadata) {
        builder.withMetadata(this.channel.metadata);
      }

      // Set incremental name
      builder.withName(`${prefix} ${i}`).withServerId(serverId);

      channels.push(builder.build());
    }

    return channels;
  }
}
