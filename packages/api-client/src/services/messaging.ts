import { UUID } from '@elizaos/core';
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
} from '../types/messaging';
import { PaginationParams } from '../types/base';

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
    return this.post<MessageChannel>('/api/messaging/channels', params);
  }

  /**
   * Create a group channel
   */
  async createGroupChannel(params: GroupChannelCreateParams): Promise<MessageChannel> {
    return this.post<MessageChannel>('/api/messaging/central-channels', params);
  }

  /**
   * Find or create a DM channel
   */
  async getOrCreateDmChannel(params: DmChannelParams): Promise<MessageChannel> {
    return this.get<MessageChannel>('/api/messaging/dm-channel', { params });
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
    return this.delete<{ success: boolean }>(`/api/messaging/channels/${channelId}`);
  }

  /**
   * Clear channel history
   */
  async clearChannelHistory(channelId: UUID): Promise<{ deleted: number }> {
    return this.post<{ deleted: number }>(`/api/messaging/channels/${channelId}/clear`);
  }

  /**
   * Post a new message to a channel
   */
  async postMessage(
    channelId: UUID,
    content: string,
    metadata?: Record<string, any>
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
   * Delete a message
   */
  async deleteMessage(messageId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/messaging/messages/${messageId}`);
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
}
