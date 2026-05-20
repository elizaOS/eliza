/**
 * Monitored Storage Service
 * Wraps storage operations with performance monitoring
 *
 * Note: This file provides the interface but requires the storage client
 * to be injected from the application layer.
 */

import { performanceMonitor } from "./performance-monitor";

// Storage client interface - to be injected from app
export interface StorageClient {
  uploadImage(options: {
    file: Buffer;
    filename: string;
    contentType: string;
    folder?:
      | "profiles"
      | "covers"
      | "posts"
      | "user-profiles"
      | "user-banners"
      | "actors"
      | "actor-banners"
      | "organizations"
      | "org-banners"
      | "logos"
      | "icons"
      | "static";
    optimize?: boolean;
  }): Promise<{ url: string; key: string; size: number }>;
}

let storageClientInstance: StorageClient | null = null;

export function setStorageClient(client: StorageClient): void {
  storageClientInstance = client;
}

function getStorageClient(): StorageClient {
  if (!storageClientInstance) {
    throw new Error(
      "StorageClient not initialized. Call setStorageClient() first.",
    );
  }
  return storageClientInstance;
}

/**
 * Upload file with monitoring
 */
export async function monitoredUploadImage(options: {
  file: Buffer;
  filename: string;
  contentType: string;
  folder?:
    | "profiles"
    | "covers"
    | "posts"
    | "user-profiles"
    | "user-banners"
    | "actors"
    | "actor-banners"
    | "organizations"
    | "org-banners"
    | "logos"
    | "icons"
    | "static";
  optimize?: boolean;
}): Promise<{ url: string; key: string; size: number }> {
  const startTime = performance.now();

  const storageClient = getStorageClient();
  const result = await storageClient.uploadImage(options);
  const latency = performance.now() - startTime;

  performanceMonitor.recordStorageOperation("upload", latency, result.size);

  return result;
}

/**
 * Note: Storage client currently doesn't expose deleteFile method.
 * This is a placeholder for when that functionality is added.
 * For now, we only monitor uploads.
 */
