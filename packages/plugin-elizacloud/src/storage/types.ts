/**
 * Cloud Storage Types
 */

/** Configuration for cloud storage */
export interface CloudStorageConfig {
  apiKey: string;
  baseUrl: string;
}

/** Result of a storage upload */
export interface StorageUploadResult {
  success: boolean;
  id?: string;
  url?: string;
  pathname?: string;
  contentType?: string;
  size?: number;
  /** Cost charged for this upload (e.g., "$0.01") */
  cost?: string;
  /** Remaining credit balance after upload (e.g., "$99.99") */
  creditsRemaining?: string;
  error?: string;
}

/** A stored item */
export interface StorageItem {
  id: string;
  url: string;
  pathname: string;
  contentType: string;
  size: number;
  /** ISO timestamp of when the file was uploaded */
  uploadedAt: string;
}

/** Result of listing stored items */
export interface StorageListResult {
  items: StorageItem[];
  cursor?: string;
  hasMore: boolean;
}

/** Upload options */
export interface StorageUploadOptions {
  filename?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}
