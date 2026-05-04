/**
 * Voice Message Handler
 *
 * Handles processing of Discord voice message attachments:
 * - Downloads audio files from Discord
 * - Uploads to blob storage (currently disabled — see note below)
 * - Generates pre-signed URLs for agents
 * - Cleans up expired audio files
 *
 * TODO: Wire to R2-backed upload service. Until this gateway is pointed at
 * the Worker R2 upload endpoint (or given direct S3-compatible R2
 * credentials), `processVoiceMessage` returns the Discord CDN URL directly
 * and `cleanupExpiredAudio` is a no-op. Both branches are gated by
 * `VOICE_BLOB_ENABLED=1`.
 */

import { type Attachment, MessageFlags } from "discord.js";
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

const CLEANUP_INTERVAL_MS = parseIntEnv("VOICE_CLEANUP_INTERVAL_MS", 900_000); // 15 minutes

const MAX_VOICE_FILE_SIZE = 25 * 1024 * 1024; // 25MB Discord limit

/** Timeout for Discord CDN fetch operations */
const DISCORD_CDN_TIMEOUT_MS = 30_000; // 30 seconds

const VOICE_BLOB_ENABLED = process.env.VOICE_BLOB_ENABLED === "1";

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
  return attachment.contentType?.startsWith("audio/") || attachment.name?.endsWith(".ogg");
}

/**
 * Checks if a message contains voice attachments.
 */
export function hasVoiceAttachments(
  attachments: ReadonlyMap<string, Attachment> | readonly Attachment[],
  flags?: { bitfield: number } | null,
): boolean {
  if (flags && (flags.bitfield & MessageFlags.IsVoiceMessage) !== 0) {
    return true;
  }

  const attachmentArray =
    attachments instanceof Map
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
   * Downloads the audio file and (when blob upload is wired) uploads it.
   * While `VOICE_BLOB_ENABLED` is unset the attachment is downloaded and
   * size-validated but no blob is persisted — the original Discord CDN URL
   * is returned in the result.
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

    if (!VOICE_BLOB_ENABLED) {
      logger.warn("Voice blob upload disabled (VOICE_BLOB_ENABLED!=1); returning Discord CDN URL", {
        connectionId,
        messageId,
        attachmentId: attachment.id,
      });
      return {
        audioUrl: attachment.url,
        expiresAt: new Date(Date.now() + VOICE_AUDIO_TTL_SECONDS * 1000),
        size: audioBuffer.length,
        contentType: attachment.contentType ?? "audio/ogg; codecs=opus",
      };
    }

    // TODO: Wire to R2-backed upload service. Until then this branch is
    // unreachable in practice and exists only as a placeholder for the
    // future R2 client integration.
    throw new Error(
      "Voice blob upload is enabled but no upload backend is wired. Implement R2 upload before setting VOICE_BLOB_ENABLED=1.",
    );
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

    const attachmentArray =
      attachments instanceof Map
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
          filename: voiceAttachments[index].name ?? `voice-${voiceAttachments[index].id}.ogg`,
        });
      } else {
        const attachmentId = voiceAttachments[index].id;
        const errorMessage =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
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
   * No-op until the R2-backed upload backend is wired up.
   */
  async cleanupExpiredAudio(): Promise<number> {
    if (!VOICE_BLOB_ENABLED) {
      logger.debug("Voice blob upload disabled; skipping cleanup");
      return 0;
    }

    // TODO: Wire to R2-backed cleanup. Needs list-by-prefix + delete on the
    // managed R2 bucket (or a backend-side cron driving the same).
    logger.warn("Voice blob cleanup is enabled but no backend is wired; skipping.");
    return 0;
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
