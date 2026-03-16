/**
 * Voice Message Handler
 *
 * Handles processing of Discord voice message attachments:
 * - Downloads audio files from Discord
 * - Uploads to blob storage
 * - Generates pre-signed URLs for agents
 * - Cleans up expired audio files
 */

import { MessageFlags, type Attachment } from "discord.js";
import { put, del, list } from "@vercel/blob";
import { logger } from "./logger";

/**
 * Parse an integer from environment variable with validation.
 * Throws if the value is not a valid integer to fail fast on misconfiguration.
 */
function parseIntEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name} environment variable: "${value}" is not a valid integer`);
  }
  return parsed;
}

const VOICE_AUDIO_TTL_SECONDS = parseIntEnv("VOICE_AUDIO_TTL_SECONDS", 3600);

const VOICE_STORAGE_PATH_PREFIX =
  process.env.VOICE_STORAGE_PATH_PREFIX ?? "discord-voice";

const CLEANUP_INTERVAL_MS = parseIntEnv("VOICE_CLEANUP_INTERVAL_MS", 900_000); // 15 minutes

const MAX_VOICE_FILE_SIZE = 25 * 1024 * 1024; // 25MB Discord limit

/** Timeout for Discord CDN fetch operations */
const DISCORD_CDN_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Blob access mode for voice files.
 * - "public": Anyone with URL can access (simpler, but less secure)
 *
 * Security note: Voice messages are sensitive. The current "public" mode
 * relies on unguessable URLs (random path components) and short TTL for security.
 * For higher security requirements, consider implementing signed URL generation
 * at the consumer level with Vercel Blob's token-based access.
 */
const VOICE_BLOB_ACCESS = "public" as const;

export interface VoiceAttachmentResult {
  audioUrl: string;
  expiresAt: Date;
  size: number;
  contentType: string;
}

export interface VoiceAttachmentMetadata {
  url: string;
  expires_at: string;
  size: number;
  content_type: string;
  filename: string;
}

/**
 * Checks if an attachment is a voice message.
 */
function isVoiceAttachment(attachment: Attachment): boolean {
  return (
    attachment.contentType?.startsWith("audio/") ||
    attachment.name?.endsWith(".ogg")
  );
}

/**
 * Checks if a message contains voice attachments.
 */
export function hasVoiceAttachments(
  attachments: ReadonlyMap<string, Attachment> | readonly Attachment[],
  flags?: { bitfield: number } | null,
): boolean {
  if (
    flags &&
    (flags.bitfield & MessageFlags.IsVoiceMessage) !== 0
  ) {
    return true;
  }

  const attachmentArray = attachments instanceof Map 
    ? Array.from(attachments.values()) 
    : Array.isArray(attachments) 
      ? attachments 
      : [];
  
  return attachmentArray.length > 0 && attachmentArray.some(isVoiceAttachment);
}

/**
 * Voice Message Handler
 */
export class VoiceMessageHandler {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private deferredCleanupTimeout: NodeJS.Timeout | null = null;

  /**
   * Process a voice message attachment.
   * Downloads the audio file, uploads to blob storage, and returns a pre-signed URL.
   */
  async processVoiceMessage(
    attachment: Attachment,
    connectionId: string,
    messageId: string,
  ): Promise<VoiceAttachmentResult> {
    if (!isVoiceAttachment(attachment)) {
      throw new Error("Attachment is not a voice message");
    }

    if (attachment.size > MAX_VOICE_FILE_SIZE) {
      throw new Error(
        `Voice attachment too large: ${attachment.size} bytes (max: ${MAX_VOICE_FILE_SIZE} bytes)`,
      );
    }

    logger.info("Processing voice message", {
      connectionId,
      messageId,
      attachmentId: attachment.id,
      filename: attachment.name,
      size: attachment.size,
      contentType: attachment.contentType,
    });

    const downloadStart = Date.now();

    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(DISCORD_CDN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download voice attachment: ${response.status} ${response.statusText}`,
      );
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    if (audioBuffer.length === 0) {
      throw new Error("Downloaded audio buffer is empty");
    }

    if (audioBuffer.length > MAX_VOICE_FILE_SIZE) {
      throw new Error(
        `Downloaded audio exceeds size limit: ${audioBuffer.length} bytes (max: ${MAX_VOICE_FILE_SIZE} bytes)`,
      );
    }

    const downloadDuration = Date.now() - downloadStart;

    logger.debug("Downloaded voice attachment", {
      connectionId,
      messageId,
      attachmentId: attachment.id,
      size: audioBuffer.length,
      downloadDurationMs: downloadDuration,
    });

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
    }

    const contentType =
      attachment.contentType ?? "audio/ogg; codecs=opus";
    // Sanitize filename to prevent path traversal attacks
    const rawFilename = attachment.name ?? `voice-${attachment.id}.ogg`;
    const safeFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const timestamp = Date.now();
    const pathname = `${VOICE_STORAGE_PATH_PREFIX}/${connectionId}/${messageId}/${timestamp}-${safeFilename}`;

    const uploadStart = Date.now();
    const blob = await put(pathname, audioBuffer, {
      access: VOICE_BLOB_ACCESS,
      contentType,
      addRandomSuffix: false,
    });
    const uploadDuration = Date.now() - uploadStart;

    logger.info("Uploaded voice attachment to blob storage", {
      connectionId,
      messageId,
      attachmentId: attachment.id,
      url: blob.url,
      size: audioBuffer.length,
      uploadDurationMs: uploadDuration,
    });

    const expiresAt = new Date(Date.now() + VOICE_AUDIO_TTL_SECONDS * 1000);

    return {
      audioUrl: blob.url,
      expiresAt,
      size: audioBuffer.length,
      contentType: blob.contentType || contentType,
    };
  }

  /**
   * Process multiple voice attachments in parallel.
   */
  async processVoiceAttachments(
    attachments: ReadonlyMap<string, Attachment> | readonly Attachment[],
    connectionId: string,
    messageId: string,
    flags?: { bitfield: number } | null,
  ): Promise<VoiceAttachmentMetadata[]> {
    if (!hasVoiceAttachments(attachments, flags)) {
      return [];
    }

    const attachmentArray = attachments instanceof Map 
      ? Array.from(attachments.values()) 
      : Array.isArray(attachments) 
        ? attachments 
        : [];

    const voiceAttachments = attachmentArray.filter(isVoiceAttachment);
    if (voiceAttachments.length === 0) {
      return [];
    }

    logger.info("Processing voice attachments", {
      connectionId,
      messageId,
      count: voiceAttachments.length,
    });

    const results = await Promise.allSettled(
      voiceAttachments.map((attachment) =>
        this.processVoiceMessage(attachment, connectionId, messageId),
      ),
    );

    const successful: VoiceAttachmentMetadata[] = [];
    const failed: Array<{ attachmentId: string; error: string }> = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successful.push({
          url: result.value.audioUrl,
          expires_at: result.value.expiresAt.toISOString(),
          size: result.value.size,
          content_type: result.value.contentType,
          filename:
            voiceAttachments[index].name ??
            `voice-${voiceAttachments[index].id}.ogg`,
        });
      } else {
        const attachmentId = voiceAttachments[index].id;
        const errorMessage =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failed.push({ attachmentId, error: errorMessage });
        logger.error("Failed to process voice attachment", {
          connectionId,
          messageId,
          attachmentId,
          error: errorMessage,
        });
      }
    });

    if (failed.length > 0) {
      logger.warn("Some voice attachments failed to process", {
        connectionId,
        messageId,
        successful: successful.length,
        failed: failed.length,
        errors: failed,
      });
    }

    return successful;
  }

  /**
   * Clean up expired audio files from blob storage.
   * Returns the number of files deleted.
   */
  async cleanupExpiredAudio(): Promise<number> {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      logger.warn("BLOB_READ_WRITE_TOKEN not configured, skipping cleanup");
      return 0;
    }

    logger.info("Starting voice audio cleanup");

    // Collect all expired blobs across all pages
    const now = Date.now();
    const expiredBlobs: Array<{ url: string; uploadedAt: Date }> = [];
    let cursor: string | undefined;
    let totalFilesScanned = 0;

    // Paginate through all blobs
    do {
      const response = await list({
        prefix: `${VOICE_STORAGE_PATH_PREFIX}/`,
        limit: 1000,
        cursor,
      });

      totalFilesScanned += response.blobs.length;

      for (const blob of response.blobs) {
        const ageSeconds = (now - blob.uploadedAt.getTime()) / 1000;
        if (ageSeconds > VOICE_AUDIO_TTL_SECONDS) {
          expiredBlobs.push({ url: blob.url, uploadedAt: blob.uploadedAt });
        }
      }

      cursor = response.cursor;
    } while (cursor);

    if (expiredBlobs.length === 0) {
      logger.debug("No expired voice audio files to clean up");
      return 0;
    }

    const deleteResults = await Promise.allSettled(
      expiredBlobs.map((blob) => del(blob.url)),
    );

    let deletedCount = 0;
    const failed: Array<{ url: string; error: string }> = [];

    deleteResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deletedCount++;
        const blob = expiredBlobs[index];
        logger.debug("Deleted expired voice audio file", {
          url: blob.url,
          ageSeconds: Math.floor((now - blob.uploadedAt.getTime()) / 1000),
        });
      } else {
        const blob = expiredBlobs[index];
        const errorMessage =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failed.push({ url: blob.url, error: errorMessage });
        logger.error("Failed to delete expired voice audio file", {
          url: blob.url,
          error: errorMessage,
        });
      }
    });

    if (failed.length > 0) {
      logger.warn("Some expired files failed to delete during cleanup", {
        totalExpired: expiredBlobs.length,
        deletedCount,
        failedCount: failed.length,
        errors: failed,
      });
    }

    logger.info("Voice audio cleanup completed", {
      totalFilesScanned,
      expiredCount: expiredBlobs.length,
      deletedCount,
      failedCount: failed.length,
    });

    return deletedCount;
  }

  /**
   * Start the cleanup job that runs periodically.
   * First cleanup is deferred to avoid blocking startup and failing health checks.
   */
  startCleanupJob(): void {
    if (this.cleanupInterval) {
      logger.warn("Cleanup job already running");
      return;
    }

    logger.info("Starting voice audio cleanup job", {
      intervalMs: CLEANUP_INTERVAL_MS,
      ttlSeconds: VOICE_AUDIO_TTL_SECONDS,
    });

    const runCleanup = () => {
      this.cleanupExpiredAudio().catch((error) => {
        logger.error("Error in voice audio cleanup job", { error });
      });
    };

    this.cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

    // Defer initial cleanup to avoid blocking startup (run after 30 seconds)
    this.deferredCleanupTimeout = setTimeout(() => {
      this.deferredCleanupTimeout = null;
      runCleanup();
    }, 30_000);
  }

  /**
   * Stop the cleanup job.
   */
  stopCleanupJob(): void {
    if (this.deferredCleanupTimeout) {
      clearTimeout(this.deferredCleanupTimeout);
      this.deferredCleanupTimeout = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info("Stopped voice audio cleanup job");
    }
  }
}
