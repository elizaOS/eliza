/**
 * ElizaOS Cloud Storage Module
 *
 * Provides file storage capabilities via ElizaOS Cloud.
 * Supports uploading, downloading, and listing files.
 */

export { CloudStorageService, createCloudStorageService } from "./service";
export type {
  CloudStorageConfig,
  StorageUploadResult,
  StorageListResult,
  StorageItem,
} from "./types";
