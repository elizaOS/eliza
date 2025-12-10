/**
 * Cloud Storage Service
 *
 * Provides file storage operations via ElizaOS Cloud API.
 * Uses credit-based authenticated storage endpoints.
 *
 * Storage costs are deducted from your credit balance automatically.
 * - Upload: ~$0.01 per MB (minimum $0.001)
 * - Download: Free for your own files
 * - Delete: Free for your own files
 */

import { logger } from "@elizaos/core";
import type {
  CloudStorageConfig,
  StorageUploadResult,
  StorageListResult,
  StorageUploadOptions,
} from "./types";

const DEFAULT_CLOUD_URL = "https://www.elizacloud.ai";

// Use authenticated storage endpoint (credit-based)
const STORAGE_ENDPOINT = "/api/v1/storage/files";

/**
 * Creates a cloud storage service instance
 */
export function createCloudStorageService(
  config: CloudStorageConfig,
): CloudStorageService {
  return new CloudStorageService(config);
}

/**
 * Cloud Storage Service for ElizaOS Cloud
 */
export class CloudStorageService {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: CloudStorageConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || DEFAULT_CLOUD_URL;
  }

  /**
   * Upload a file to cloud storage
   */
  async upload(
    file: Buffer | Blob | File,
    options: StorageUploadOptions = {},
  ): Promise<StorageUploadResult> {
    try {
      const formData = new FormData();

      // Convert Buffer to Blob if needed
      let blob: Blob;
      if (Buffer.isBuffer(file)) {
        // Cast Buffer to BlobPart-compatible type
        blob = new Blob([file as unknown as BlobPart], {
          type: options.contentType || "application/octet-stream",
        });
      } else {
        blob = file;
      }

      const filename =
        options.filename ||
        (file instanceof File ? file.name : "file") ||
        "upload";

      formData.append("file", blob, filename);

      // Add metadata if provided
      if (options.metadata) {
        formData.append("metadata", JSON.stringify(options.metadata));
      }

      const response = await fetch(`${this.baseUrl}${STORAGE_ENDPOINT}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        
        // Handle insufficient credits (402)
        if (response.status === 402) {
          return {
            success: false,
            error: `Insufficient credits. Required: ${errorData.required || "unknown"}, Available: ${errorData.available || "unknown"}. Top up at ${errorData.topUpUrl || "/dashboard/billing"}`,
          };
        }
        
        return {
          success: false,
          error: `Upload failed: ${response.status} ${errorData.error || "Unknown error"}`,
        };
      }

      const data = await response.json();
      
      logger.info(
        { src: "plugin:elizacloud", cost: data.cost, remaining: data.creditsRemaining },
        "Storage upload successful"
      );
      
      return {
        success: true,
        id: data.id,
        url: data.url,
        pathname: data.pathname,
        contentType: data.contentType,
        size: data.size,
        cost: data.cost,
        creditsRemaining: data.creditsRemaining,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ src: "plugin:elizacloud", error }, "Storage upload failed");
      return {
        success: false,
        error: `Upload error: ${message}`,
      };
    }
  }

  /**
   * Download a file from cloud storage
   * @param id - File ID
   * @param url - Full URL of the file (required for download)
   */
  async download(id: string, url?: string): Promise<Buffer | null> {
    // If URL is provided, download directly from it
    if (url) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          logger.error(
            { src: "plugin:elizacloud", status: response.status, url },
            "Storage direct download failed",
          );
          return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (error) {
        logger.error({ src: "plugin:elizacloud", error }, "Storage direct download error");
        return null;
      }
    }
    
    // Otherwise, try to get metadata first to get the URL
    try {
      const response = await fetch(
        `${this.baseUrl}${STORAGE_ENDPOINT}/${id}?download=true`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          redirect: "follow",
        }
      );

      if (!response.ok) {
        logger.error(
          { src: "plugin:elizacloud", status: response.status },
          "Storage download failed",
        );
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error({ src: "plugin:elizacloud", error }, "Storage download error");
      return null;
    }
  }

  /**
   * List files in cloud storage
   * Lists files owned by your organization
   */
  async list(options: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<StorageListResult> {
    try {
      const params = new URLSearchParams();
      if (options.prefix) params.set("prefix", options.prefix);
      if (options.limit) params.set("limit", String(options.limit));
      if (options.cursor) params.set("cursor", options.cursor);

      const response = await fetch(
        `${this.baseUrl}${STORAGE_ENDPOINT}?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!response.ok) {
        logger.error(
          { src: "plugin:elizacloud", status: response.status },
          "Storage list failed",
        );
        return { items: [], hasMore: false };
      }

      const data = await response.json();
      return {
        items: data.items || [],
        cursor: data.cursor,
        hasMore: data.hasMore || false,
      };
    } catch (error) {
      logger.error({ src: "plugin:elizacloud", error }, "Storage list error");
      return { items: [], hasMore: false };
    }
  }

  /**
   * Delete a file from cloud storage
   * @param id - File ID
   * @param url - Full URL of the file (required for deletion)
   */
  async delete(id: string, url?: string): Promise<boolean> {
    if (!url) {
      logger.error({ src: "plugin:elizacloud" }, "Storage delete requires file URL");
      return false;
    }
    
    try {
      const params = new URLSearchParams({ url });
      const response = await fetch(
        `${this.baseUrl}${STORAGE_ENDPOINT}/${id}?${params.toString()}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error(
          { src: "plugin:elizacloud", status: response.status, error: errorData.error },
          "Storage delete failed"
        );
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error({ src: "plugin:elizacloud", error }, "Storage delete error");
      return false;
    }
  }

  /**
   * Get storage stats for your organization
   */
  async getStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    totalSizeGB: number;
    pricing: {
      uploadPerMB: string;
      retrievalPerMB: string;
      minUploadFee: string;
    };
  } | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}${STORAGE_ENDPOINT}?stats=true`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return {
        totalFiles: data.stats?.totalFiles || 0,
        totalSize: data.stats?.totalSize || 0,
        totalSizeGB: data.stats?.totalSizeGB || 0,
        pricing: data.pricing || {},
      };
    } catch (error) {
      logger.error({ src: "plugin:elizacloud", error }, "Storage stats error");
      return null;
    }
  }
}
