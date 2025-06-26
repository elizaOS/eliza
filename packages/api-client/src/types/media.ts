import { UUID } from '@elizaos/core';

export interface MediaUploadParams {
  file: File | Blob;
  filename?: string;
  contentType?: string;
  metadata?: Record<string, any>;
}

export interface MediaUploadResponse {
  url: string;
  type: string;
  filename: string;
  originalName: string;
  size: number;
}

export interface ChannelUploadResponse {
  url: string;
  type: string;
  filename: string;
  originalName: string;
  size: number;
}
