import { UUID } from '@elizaos/core';

export interface MediaUploadParams {
  file: File | Blob;
  filename?: string;
  contentType?: string;
  metadata?: Record<string, any>;
}

export interface MediaUploadResponse {
  id: UUID;
  filename: string;
  url: string;
  size: number;
  contentType: string;
  uploadedAt: Date;
  metadata?: Record<string, any>;
}

export interface ChannelUploadParams {
  files: Array<File | Blob>;
  messageId?: UUID;
  metadata?: Record<string, any>;
}

export interface ChannelUploadResponse {
  uploads: MediaUploadResponse[];
  totalSize: number;
}
