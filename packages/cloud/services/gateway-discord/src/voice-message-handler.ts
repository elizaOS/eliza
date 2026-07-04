/**
 * Voice Message Handler
 *
 * Handles processing of Discord voice message attachments:
 * - Downloads audio files from Discord
 * - Uploads to the Cloud API storage proxy when configured
 * - Generates pre-signed URLs for agents
 * - Cleans up expired audio files
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
    throw new Error(
      `Invalid ${name} environment variable: "${value}" is not a valid integer`,
    );
  }
  return parsed;
}

const VOICE_AUDIO_TTL_SECONDS = parseIntEnv("VOICE_AUDIO_TTL_SECONDS", 3600);

const CLEANUP_INTERVAL_MS = parseIntEnv("VOICE_CLEANUP_INTERVAL_MS", 900_000); // 15 minutes

const MAX_VOICE_FILE_SIZE = 25 * 1024 * 1024; // 25MB Discord limit

/** Timeout for Discord CDN fetch operations */
const DISCORD_CDN_TIMEOUT_MS = 30_000; // 30 seconds
const STORAGE_FETCH_TIMEOUT_MS = 30_000;
const VOICE_STORAGE_PREFIX = "voice";

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

interface StorageConfig {
  apiBaseUrl: string;
  token: string;
}

function getStorageConfig(): StorageConfig | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  const apiBaseUrl = (
    process.env.ELIZA_CLOUD_URL ??
    process.env.CLOUD_API_BASE_URL ??
    process.env.ELIZAOS_CLOUD_BASE_URL ??
    ""
  ).trim();
  if (!token || !apiBaseUrl) return null;
  return { token, apiBaseUrl: apiBaseUrl.replace(/\/+$/, "") };
}

function storageHeaders(config: StorageConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    "X-API-Key": config.token,
  };
}

function objectUrl(config: StorageConfig, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${config.apiBaseUrl}/api/v1/apis/storage/objects/${encodedKey}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildVoiceObjectKey(
  connectionId: string,
  messageId: string,
  attachment: Attachment,
): string {
  const rawName = attachment.name ?? `voice-${attachment.id}.ogg`;
  const safeName = sanitizeFilename(rawName).replace(/^\.+$/, "voice.ogg");
  return [
    VOICE_STORAGE_PREFIX,
    sanitizeFilename(connectionId),
    sanitizeFilename(messageId),
    `${sanitizeFilename(attachment.id)}-${safeName}`,
  ].join("/");
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function uploadVoiceObject(
  config: StorageConfig,
  key: string,
  audioBuffer: Buffer,
  contentType: string,
): Promise<void> {
  const response = await fetch(objectUrl(config, key), {
    method: "PUT",
    headers: {
      ...storageHeaders(config),
      "Content-Type": contentType,
    },
    body: new Uint8Array(audioBuffer),
    signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await parseJsonResponse(response);
    throw new Error(
      `Voice upload failed: ${response.status} ${response.statusText} ${JSON.stringify(body)}`,
    );
  }
}

async function presignVoiceObject(
  config: StorageConfig,
  key: string,
): Promise<{ url: string; expiresAt: Date }> {
  const response = await fetch(
    `${config.apiBaseUrl}/api/v1/apis/storage/presign`,
    {
      method: "POST",
      headers: {
        ...storageHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key,
        operation: "get",
        expiresIn: VOICE_AUDIO_TTL_SECONDS,
      }),
      signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
    },
  );
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Voice presign failed: ${response.status} ${response.statusText} ${JSON.stringify(body)}`,
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { url?: unknown }).url !== "string" ||
    typeof (body as { expiresAt?: unknown }).expiresAt !== "string"
  ) {
    throw new Error("Voice presign response missing url or expiresAt");
  }
  return {
    url: (body as { url: string }).url,
    expiresAt: new Date((body as { expiresAt: string }).expiresAt),
  };
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
   * Downloads the audio file, uploads it to managed storage when configured,
   * and returns a short-lived URL agents can consume.
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

    const storageConfig = getStorageConfig();
    const contentType = attachment.contentType ?? "audio/ogg; codecs=opus";
    if (storageConfig) {
      const objectKey = buildVoiceObjectKey(
        connectionId,
        messageId,
        attachment,
      );
      await uploadVoiceObject(
        storageConfig,
        objectKey,
        audioBuffer,
        contentType,
      );
      const signed = await presignVoiceObject(storageConfig, objectKey);
      logger.info("Uploaded voice attachment to managed storage", {
        connectionId,
        messageId,
        attachmentId: attachment.id,
        objectKey,
      });
      return {
        audioUrl: signed.url,
        expiresAt: signed.expiresAt,
        size: audioBuffer.length,
        contentType,
      };
    }

    logger.warn(
      "Voice storage proxy not configured; returning Discord CDN URL",
      {
        connectionId,
        messageId,
        attachmentId: attachment.id,
      },
    );
    return {
      audioUrl: attachment.url,
      expiresAt: new Date(Date.now() + VOICE_AUDIO_TTL_SECONDS * 1000),
      size: audioBuffer.length,
      contentType,
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
   */
  async cleanupExpiredAudio(): Promise<number> {
    const storageConfig = getStorageConfig();
    if (!storageConfig) {
      logger.debug("Voice storage proxy not configured; skipping cleanup");
      return 0;
    }

    const listUrl = new URL(
      `${storageConfig.apiBaseUrl}/api/v1/apis/storage/list`,
    );
    listUrl.searchParams.set("prefix", VOICE_STORAGE_PREFIX);
    listUrl.searchParams.set("recursive", "true");

    const response = await fetch(listUrl, {
      headers: storageHeaders(storageConfig),
      signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        `Voice cleanup list failed: ${response.status} ${response.statusText} ${JSON.stringify(body)}`,
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { items?: unknown }).items)
    ) {
      throw new Error("Voice cleanup list response missing items");
    }

    const cutoff = Date.now() - VOICE_AUDIO_TTL_SECONDS * 1000;
    let deleted = 0;
    for (const item of (body as { items: unknown[] }).items) {
      if (!item || typeof item !== "object") continue;
      const { key, modifiedAt } = item as {
        key?: unknown;
        modifiedAt?: unknown;
      };
      if (typeof key !== "string" || typeof modifiedAt !== "string") continue;
      const modifiedTime = new Date(modifiedAt).getTime();
      if (!Number.isFinite(modifiedTime) || modifiedTime >= cutoff) continue;

      const deleteResponse = await fetch(objectUrl(storageConfig, key), {
        method: "DELETE",
        headers: storageHeaders(storageConfig),
        signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
      });
      if (!deleteResponse.ok) {
        const deleteBody = await parseJsonResponse(deleteResponse);
        logger.warn("Failed to delete expired voice object", {
          key,
          status: deleteResponse.status,
          body: deleteBody,
        });
        continue;
      }
      deleted += 1;
    }

    logger.info("Cleaned up expired voice audio", { deleted });
    return deleted;
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

    // Defers the initial retention pass so startup is not blocked
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
