/**
 * Storage client with support for both local (MinIO) and production (Vercel Blob)
 * Uses MinIO for local development and Vercel Blob for production deployments
 *
 * Image optimization is handled by Vercel's Image Optimization CDN when using next/image.
 * This client uploads raw images without server-side processing.
 * @see https://vercel.com/docs/image-optimization
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutBucketPolicyCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { logger } from "@polyagent/shared";
import { del as vercelBlobDel, put as vercelBlobPut } from "@vercel/blob";

// Storage configuration
const isProduction = process.env.NODE_ENV === "production";
const useVercelBlob =
  process.env.USE_VERCEL_BLOB === "true" ||
  (isProduction && process.env.BLOB_READ_WRITE_TOKEN);

// MinIO configuration (local development)
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://localhost:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "polyagent";
const MINIO_SECRET_KEY =
  process.env.MINIO_SECRET_KEY || "polyagent_dev_password";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "polyagent-uploads";

// Vercel Blob configuration (production)
// Token is automatically available in Vercel environment as BLOB_READ_WRITE_TOKEN
const VERCEL_BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

interface UploadOptions {
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
}

interface UploadResult {
  url: string;
  key: string;
  size: number;
}

class S3StorageClient {
  private client: S3Client | null = null;
  private bucket!: string;
  private publicUrl!: string | null;
  private useVercel!: boolean;

  constructor() {
    this.useVercel = !!useVercelBlob;

    if (this.useVercel) {
      // Vercel Blob configuration
      if (!VERCEL_BLOB_TOKEN) {
        logger.warn("Vercel Blob token not found, falling back to MinIO");
        this.useVercel = false;
      } else {
        this.bucket = "polyagent-uploads";
        this.publicUrl = null; // Vercel Blob provides its own URLs
        logger.info("Storage: Using Vercel Blob (production)");
      }
    }

    if (!this.useVercel) {
      // MinIO configuration (local dev or fallback)
      this.client = new S3Client({
        region: "us-east-1",
        endpoint: MINIO_ENDPOINT,
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY,
        },
        forcePathStyle: true, // Required for MinIO
      });
      this.bucket = MINIO_BUCKET;
      this.publicUrl = MINIO_ENDPOINT;

      logger.info("Storage: Using MinIO (local)");
    }
  }

  /**
   * Upload an image file
   * Images are uploaded as-is; optimization is handled by Vercel's Image Optimization CDN
   */
  async uploadImage(options: UploadOptions): Promise<UploadResult> {
    const buffer = options.file;

    // Generate path/key
    const folder = options.folder || "uploads";
    const pathname = `${folder}/${options.filename}`;

    if (this.useVercel) {
      // Upload to Vercel Blob
      const blob = await vercelBlobPut(pathname, buffer, {
        access: "public",
        contentType: options.contentType,
        addRandomSuffix: false, // We already have unique filenames
      });

      logger.info("Image uploaded successfully to Vercel Blob", {
        pathname: blob.pathname,
        size: buffer.length,
        url: blob.url,
      });

      return {
        url: blob.url,
        key: blob.pathname,
        size: buffer.length,
      };
    }

    // Upload to MinIO/S3
    if (!this.client) {
      throw new Error("S3 client not initialized");
    }

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: pathname,
        Body: buffer,
        ContentType: options.contentType,
        CacheControl: "public, max-age=31536000, immutable",
      },
    });

    await upload.done();

    // Generate public URL
    const url = this.publicUrl
      ? `${this.publicUrl}/${this.bucket}/${pathname}`
      : `http://localhost:9000/${this.bucket}/${pathname}`;

    logger.info("Image uploaded successfully to MinIO", {
      key: pathname,
      size: buffer.length,
      bucket: this.bucket,
    });

    return {
      url,
      key: pathname,
      size: buffer.length,
    };
  }

  /**
   * Delete an image file
   */
  async deleteImage(url: string): Promise<void> {
    if (this.useVercel) {
      // Delete from Vercel Blob
      await vercelBlobDel(url);
      logger.info("Image deleted successfully from Vercel Blob", { url });
    } else {
      // Delete from MinIO/S3
      if (!this.client) {
        throw new Error("S3 client not initialized");
      }

      // Extract key from URL if full URL is provided
      let key = url;
      if (url.startsWith("http")) {
        // URL format: http://localhost:9000/polyagent-uploads/folder/file.jpg
        // Extract: folder/file.jpg
        const urlParts = url.split(`/${this.bucket}/`);
        key = urlParts.length > 1 ? urlParts[1] || url : url;
      }

      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(command);
      logger.info("Image deleted successfully from MinIO", { key });
    }
  }

  /**
   * Initialize bucket (for development/MinIO only)
   */
  async initializeBucket(): Promise<void> {
    if (this.useVercel) {
      logger.info("Using Vercel Blob - no bucket initialization needed");
      return;
    }

    await this.client?.send(new CreateBucketCommand({ Bucket: this.bucket }));
    logger.info(`Created bucket: ${this.bucket}`);

    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
        },
      ],
    };

    await this.client?.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: JSON.stringify(policy),
      }),
    );
    logger.info(`Set public policy for bucket: ${this.bucket}`);
  }

  /**
   * List objects in a folder
   */
  async listObjects(prefix: string): Promise<string[]> {
    if (this.useVercel) {
      const { list } = await import("@vercel/blob");
      const { blobs } = await list({ prefix });
      return blobs.map((blob) => blob.pathname);
    } else {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      });
      const response = await this.client?.send(command);
      return (response.Contents || []).map((obj) => obj.Key || "");
    }
  }

  /**
   * Check if an object exists
   */
  async exists(key: string): Promise<boolean> {
    if (this.useVercel) {
      const { head } = await import("@vercel/blob");
      await head(key);
      return true;
    } else {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      if (!this.client) {
        return false;
      }
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    }
  }
}

// Singleton instance
let storageClient: S3StorageClient | null = null;

export function getStorageClient(): S3StorageClient {
  if (!storageClient) {
    storageClient = new S3StorageClient();
  }
  return storageClient;
}

export type { UploadOptions, UploadResult };
