import { UUID, ChannelType } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import {
  Message,
  MessageServer,
  MessageChannel,
  MessageSubmitParams,
  MessageCompleteParams,
  ExternalMessageParams,
  ChannelCreateParams,
  GroupChannelCreateParams,
  DmChannelParams,
  ChannelParticipant,
  MessageSearchParams,
  ServerCreateParams,
  ServerSyncParams,
  ChannelUpdateParams,
  ChannelMetadata,
  MessageMetadata,
} from '../types/messaging';
import { PaginationParams } from '../types/base';

// Internal payload interfaces for API requests
interface ChannelCreatePayload {
  name: string;
  type: ChannelType;
  server_id: UUID;
  metadata?: ChannelMetadata;
}

interface GroupChannelCreatePayload {
  name: string;
  server_id: UUID;
  participantCentralUserIds: UUID[];
  type?: ChannelType;
  metadata?: ChannelMetadata;
}

interface DmChannelQuery {
  currentUserId: UUID;
  targetUserId: UUID;
  dmServerId: UUID;
}

export class MessagingService extends BaseApiClient {
  /**
   * Submit agent replies or system messages
   */
  async submitMessage(params: MessageSubmitParams): Promise<Message> {
    return this.post<Message>('/api/messaging/submit', params);
  }

  /**
   * Notify message completion
   */
  async completeMessage(params: MessageCompleteParams): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>('/api/messaging/complete', params);
  }

  /**
   * Ingest messages from external platforms
   */
  async ingestExternalMessages(params: ExternalMessageParams): Promise<{ processed: number }> {
    return this.post<{ processed: number }>('/api/messaging/ingest-external', params);
  }

  /**
   * Create a new channel
   */
  async createChannel(params: ChannelCreateParams): Promise<MessageChannel> {
    // Server expects: { name, type, server_id, metadata }
    const payload: ChannelCreatePayload = {
      name: params.name,
      type: params.type,
      server_id: params.serverId || ('00000000-0000-0000-0000-000000000000' as UUID),
      metadata: params.metadata,
    };
    return this.post<MessageChannel>('/api/messaging/central-channels', payload);
  }

  /**
   * Create a group channel
   */
  async createGroupChannel(params: GroupChannelCreateParams): Promise<MessageChannel> {
    // Server expects: { name, server_id, participantCentralUserIds, type?, metadata? }
    // The client currently provides participantIds and may include server_id/type in metadata.
    const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

    // Extract and clean metadata - handle legacy fields that might be in metadata
    let cleanedMetadata: ChannelMetadata | undefined;
    let serverIdFromMeta: UUID | undefined;
    let typeFromMeta: ChannelType | undefined;

    if (params.metadata) {
      // Create a new metadata object without the hoisted fields
      const metadataCopy: ChannelMetadata = { ...params.metadata };

      // Extract hoisted fields safely using bracket notation (ChannelMetadata allows [key: string]: unknown)
      if ('server_id' in metadataCopy) {
        serverIdFromMeta = metadataCopy['server_id'] as UUID | undefined;
        delete metadataCopy['server_id'];
      }

      if ('type' in metadataCopy) {
        typeFromMeta = metadataCopy['type'] as ChannelType | undefined;
        delete metadataCopy['type'];
      }

      // Only include metadata if there are remaining properties
      if (Object.keys(metadataCopy).length > 0) {
        cleanedMetadata = metadataCopy;
      }
    }

    const payload: GroupChannelCreatePayload = {
      name: params.name,
      server_id: serverIdFromMeta || DEFAULT_SERVER_ID,
      participantCentralUserIds: params.participantIds,
      // If caller intended DM, allow type override
      ...(typeFromMeta ? { type: typeFromMeta } : {}),
      ...(cleanedMetadata ? { metadata: cleanedMetadata } : {}),
    };

    return this.post<MessageChannel>('/api/messaging/central-channels', payload);
  }

  /**
   * Find or create a DM channel
   */
  async getOrCreateDmChannel(params: DmChannelParams): Promise<MessageChannel> {
    // Map participantIds -> { currentUserId, targetUserId }
    const [userA, userB] = params.participantIds;
    // Arbitrarily treat the first as current and second as target; callers pass [current, target]
    const query: DmChannelQuery = {
      currentUserId: userA,
      targetUserId: userB,
      dmServerId: '00000000-0000-0000-0000-000000000000' as UUID,
    };
    return this.get<MessageChannel>('/api/messaging/dm-channel', { params: query });
  }

  /**
   * Get channel details
   */
  async getChannelDetails(channelId: UUID): Promise<MessageChannel> {
    return this.get<MessageChannel>(`/api/messaging/central-channels/${channelId}/details`);
  }

  /**
   * Get channel participants
   */
  async getChannelParticipants(channelId: UUID): Promise<{ participants: ChannelParticipant[] }> {
    return this.get<{ participants: ChannelParticipant[] }>(
      `/api/messaging/central-channels/${channelId}/participants`
    );
  }

  /**
   * Add agent to channel
   */
  async addAgentToChannel(channelId: UUID, agentId: UUID): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(`/api/messaging/central-channels/${channelId}/agents`, {
      agentId,
    });
  }

  /**
   * Remove agent from channel
   */
  async removeAgentFromChannel(channelId: UUID, agentId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(
      `/api/messaging/central-channels/${channelId}/agents/${agentId}`
    );
  }

  /**
   * Delete a channel
   */
  async deleteChannel(channelId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/messaging/central-channels/${channelId}`);
  }

  /**
   * Clear channel history
   */
  async clearChannelHistory(channelId: UUID): Promise<{ deleted: number }> {
    return this.delete<{ deleted: number }>(
      `/api/messaging/central-channels/${channelId}/messages`
    );
  }

  /**
   * Post a new message to a channel
   */
  async postMessage(
    channelId: UUID,
    content: string,
    metadata?: MessageMetadata
  ): Promise<Message> {
    return this.post<Message>(`/api/messaging/central-channels/${channelId}/messages`, {
      content,
      metadata,
    });
  }

  /**
   * Get channel messages
   */
  async getChannelMessages(
    channelId: UUID,
    params?: PaginationParams & { before?: Date | string; after?: Date | string }
  ): Promise<{ messages: Message[] }> {
    return this.get<{ messages: Message[] }>(
      `/api/messaging/central-channels/${channelId}/messages`,
      { params }
    );
  }

  /**
   * Get a specific message
   */
  async getMessage(messageId: UUID): Promise<Message> {
    return this.get<Message>(`/api/messaging/messages/${messageId}`);
  }

  /**
   * Delete a message from a channel
   */
  async deleteMessage(channelId: UUID, messageId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(
      `/api/messaging/central-channels/${channelId}/messages/${messageId}`
    );
  }

  /**
   * Update a message
   */
  async updateMessage(messageId: UUID, content: string): Promise<Message> {
    return this.patch<Message>(`/api/messaging/messages/${messageId}`, { content });
  }

  /**
   * Search messages
   */
  async searchMessages(params: MessageSearchParams): Promise<{ messages: Message[] }> {
    return this.post<{ messages: Message[] }>('/api/messaging/messages/search', params);
  }

  /**
   * List all message servers
   */
  async listServers(): Promise<{ servers: MessageServer[] }> {
    return this.get<{ servers: MessageServer[] }>('/api/messaging/central-servers');
  }

  /**
   * Get server channels
   */
  async getServerChannels(serverId: UUID): Promise<{ channels: MessageChannel[] }> {
    return this.get<{ channels: MessageChannel[] }>(
      `/api/messaging/central-servers/${serverId}/channels`
    );
  }

  /**
   * Create a new server
   */
  async createServer(params: ServerCreateParams): Promise<MessageServer> {
    return this.post<MessageServer>('/api/messaging/servers', params);
  }

  /**
   * Sync server channels
   */
  async syncServerChannels(serverId: UUID, params: ServerSyncParams): Promise<{ synced: number }> {
    return this.post<{ synced: number }>(
      `/api/messaging/servers/${serverId}/sync-channels`,
      params
    );
  }

  /**
   * Delete a server
   */
  async deleteServer(serverId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/messaging/servers/${serverId}`);
  }

  /**
   * Update a channel
   */
  async updateChannel(
    channelId: UUID,
    params: ChannelUpdateParams
  ): Promise<{ success: boolean; data: MessageChannel }> {
    return this.patch<{ success: boolean; data: MessageChannel }>(
      `/api/messaging/central-channels/${channelId}`,
      params
    );
  }

  /**
   * Generate channel title
   */
  async generateChannelTitle(channelId: UUID, agentId: UUID): Promise<{ title: string }> {
    return this.post<{ title: string }>(
      `/api/messaging/central-channels/${channelId}/generate-title`,
      { agentId }
    );
  }

  /**
   * Add user to channel participants (implemented via updateChannel)
   */
  async addUserToChannel(
    channelId: UUID,
    userId: UUID
  ): Promise<{ success: boolean; data: MessageChannel }> {
    // First get current participants
    const channel = await this.getChannelDetails(channelId);
    const currentParticipants: UUID[] = channel.metadata?.participantCentralUserIds || [];

    // Add new user if not already present
    if (!currentParticipants.includes(userId)) {
      const updatedParticipants: UUID[] = [...currentParticipants, userId];
      return this.updateChannel(channelId, {
        participantCentralUserIds: updatedParticipants,
      });
    }

    return { success: true, data: channel };
  }

  /**
   * Add multiple users to channel participants (implemented via updateChannel)
   */
  async addUsersToChannel(
    channelId: UUID,
    userIds: UUID[]
  ): Promise<{ success: boolean; data: MessageChannel }> {
    // First get current participants
    const channel = await this.getChannelDetails(channelId);
    const currentParticipants: UUID[] = channel.metadata?.participantCentralUserIds || [];

    // Add new users that aren't already present
    const newParticipants: UUID[] = [...currentParticipants];
    for (const userId of userIds) {
      if (!newParticipants.includes(userId)) {
        newParticipants.push(userId);
      }
    }

    return this.updateChannel(channelId, {
      participantCentralUserIds: newParticipants,
    });
  }

  /**
   * Remove user from channel participants (implemented via updateChannel)
   */
  async removeUserFromChannel(
    channelId: UUID,
    userId: UUID
  ): Promise<{ success: boolean; data: MessageChannel }> {
    // First get current participants
    const channel = await this.getChannelDetails(channelId);
    const currentParticipants: UUID[] = channel.metadata?.participantCentralUserIds || [];

    // Remove user from participants
    const updatedParticipants: UUID[] = currentParticipants.filter((id) => id !== userId);

    return this.updateChannel(channelId, {
      participantCentralUserIds: updatedParticipants,
    });
  }
}
