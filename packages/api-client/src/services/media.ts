import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import { MediaUploadParams, MediaUploadResponse, ChannelUploadResponse } from '../types/media';

export class MediaService extends BaseApiClient {
  /**
   * Upload media for an agent
   */
  async uploadAgentMedia(agentId: UUID, params: MediaUploadParams): Promise<MediaUploadResponse> {
    const formData = new FormData();

    formData.append('file', params.file, params.filename);

    if (params.contentType) formData.append('contentType', params.contentType);
    if (params.metadata) formData.append('metadata', JSON.stringify(params.metadata));

    return this.request<MediaUploadResponse>('POST', `/api/media/agents/${agentId}/upload-media`, {
      body: formData,
    });
  }

  /**
   * Upload file to a channel
   */
  async uploadChannelMedia(channelId: UUID, file: File): Promise<ChannelUploadResponse> {
    const formData = new FormData();

    formData.append('file', file);

    return this.request<ChannelUploadResponse>(
      'POST',
      `/api/messaging/central-channels/${channelId}/upload-media`,
      {
        body: formData,
      }
    );
  }
}
