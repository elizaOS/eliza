/**
 * Blooio Automation Service
 *
 * Handles API key validation, credential storage, and message management
 * for Blooio iMessage/SMS integration. Follows the Telegram automation pattern.
 */

import { secretsService } from "@/lib/services/secrets";
import {
  type BlooioSendMessageRequest,
  type BlooioSendMessageResponse,
  blooioApiRequest,
  validateBlooioChatId,
} from "@/lib/utils/blooio-api";
import { logger } from "@/lib/utils/logger";

// Use ELIZA_API_URL (ngrok) for local dev webhooks, otherwise NEXT_PUBLIC_APP_URL
const WEBHOOK_BASE_URL =
  process.env.ELIZA_API_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

// Cache TTL for connection status (5 minutes)
const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedStatus {
  status: BlooioConnectionStatus;
  cachedAt: number;
}

export interface BlooioConnectionStatus {
  connected: boolean;
  configured: boolean;
  fromNumber?: string;
  error?: string;
}

export interface BlooioCredentials {
  apiKey: string;
  webhookSecret?: string;
  fromNumber?: string;
}

class BlooioAutomationService {
  // In-memory cache for connection status
  private statusCache = new Map<string, CachedStatus>();
  private statusRequests = new Map<string, Promise<BlooioConnectionStatus>>();
  private removeRequests = new Map<string, Promise<void>>();

  /**
   * Invalidate cached status for an organization.
   */
  invalidateStatusCache(organizationId: string): void {
    this.statusCache.delete(organizationId);
  }

  /**
   * Validate a Blooio API key by making a test request.
   */
  async validateApiKey(apiKey: string): Promise<{
    valid: boolean;
    error?: string;
  }> {
    if (!apiKey || apiKey.trim() === "") {
      return { valid: false, error: "API key is required" };
    }

    try {
      // Use the /me endpoint which returns auth context and validates the key
      // This endpoint returns organization info, devices, and usage
      await blooioApiRequest(apiKey, "GET", "/me");

      logger.info("[BlooioAutomation] API key validated successfully");
      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn("[BlooioAutomation] API key validation failed", {
        error: message,
      });

      // If it's an auth error, the key is invalid
      if (message.includes("401") || message.includes("403")) {
        return { valid: false, error: "Invalid API key" };
      }

      // For network errors, fail-secure: don't allow potentially invalid keys
      return {
        valid: false,
        error: "Validation failed due to network error. Please try again.",
      };
    }
  }

  /**
   * Store Blooio credentials in the secrets service.
   * Handles the case where secrets already exist by updating them.
   */
  async storeCredentials(
    organizationId: string,
    userId: string,
    credentials: BlooioCredentials,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "blooio-automation",
    };

    // Helper to create or update a secret
    const createOrUpdateSecret = async (name: string, value: string) => {
      try {
        await secretsService.create(
          {
            organizationId,
            name,
            value,
            scope: "organization",
            createdBy: userId,
          },
          audit,
        );
      } catch (err) {
        // If secret already exists, find it and update it
        if (err instanceof Error && err.message.includes("already exists")) {
          logger.info("[BlooioAutomation] Secret exists, updating", { name });
          const existingSecrets = await secretsService.list(organizationId);
          const existingSecret = existingSecrets.find((s) => s.name === name);
          if (existingSecret) {
            await secretsService.rotate(existingSecret.id, organizationId, value, audit);
          } else {
            throw err; // Re-throw if we can't find it
          }
        } else {
          throw err;
        }
      }
    };

    await createOrUpdateSecret("BLOOIO_API_KEY", credentials.apiKey);

    if (credentials.webhookSecret) {
      await createOrUpdateSecret("BLOOIO_WEBHOOK_SECRET", credentials.webhookSecret);
    }

    if (credentials.fromNumber) {
      await createOrUpdateSecret("BLOOIO_FROM_NUMBER", credentials.fromNumber);
    }

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[BlooioAutomation] Credentials stored", {
      organizationId,
      hasWebhookSecret: !!credentials.webhookSecret,
      hasFromNumber: !!credentials.fromNumber,
    });
  }

  /**
   * Remove Blooio credentials (disconnect).
   */
  async removeCredentials(organizationId: string, userId: string): Promise<void> {
    const pending = this.removeRequests.get(organizationId);
    if (pending) return pending;

    const request = this.removeCredentialsNow(organizationId, userId).finally(() => {
      this.removeRequests.delete(organizationId);
    });
    this.removeRequests.set(organizationId, request);
    return request;
  }

  private async removeCredentialsNow(organizationId: string, userId: string): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "blooio-automation",
    };

    const secretNames = ["BLOOIO_API_KEY", "BLOOIO_WEBHOOK_SECRET", "BLOOIO_FROM_NUMBER"];

    // Get all secrets once (not inside the loop) for efficiency
    const existingSecrets = await secretsService.list(organizationId);

    // Delete each secret by finding it in the cached list
    for (const name of secretNames) {
      const secret = existingSecrets.find((s) => s.name === name);
      if (secret) {
        try {
          await secretsService.delete(secret.id, organizationId, audit);
          logger.info("[BlooioAutomation] Deleted secret", {
            name,
            organizationId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            !message.includes("Secret not found") &&
            !message.includes("Failed to delete secret")
          ) {
            throw error;
          }
          logger.debug("[BlooioAutomation] Secret already removed during disconnect", {
            name,
            organizationId,
            error: message,
          });
        }
      }
    }

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[BlooioAutomation] Credentials removed", { organizationId });
  }

  /**
   * Get API key for an organization.
   * Falls back to env var only in non-production environments.
   */
  async getApiKey(organizationId: string): Promise<string | null> {
    const fromSecrets = await secretsService.get(organizationId, "BLOOIO_API_KEY");
    if (fromSecrets) return fromSecrets;
    // Only fall back to env var in non-production (prevents multi-tenancy violation)
    if (process.env.NODE_ENV !== "production") {
      return process.env.BLOOIO_API_KEY || null;
    }
    return null;
  }

  /**
   * Get webhook secret for an organization.
   * No env fallback in production to prevent multi-tenancy violation.
   */
  async getWebhookSecret(organizationId: string): Promise<string | null> {
    const fromSecrets = await secretsService.get(organizationId, "BLOOIO_WEBHOOK_SECRET");
    if (fromSecrets) return fromSecrets;
    // Only fall back to env var in non-production (prevents multi-tenancy violation)
    if (process.env.NODE_ENV !== "production") {
      return process.env.BLOOIO_WEBHOOK_SECRET || null;
    }
    return null;
  }

  /**
   * Get from number for an organization.
   * Falls back to env var only in non-production environments.
   */
  async getFromNumber(organizationId: string): Promise<string | null> {
    const fromSecrets = await secretsService.get(organizationId, "BLOOIO_FROM_NUMBER");
    if (fromSecrets) return fromSecrets;
    // Only fall back to env var in non-production (prevents multi-tenancy violation)
    if (process.env.NODE_ENV !== "production") {
      return process.env.BLOOIO_FROM_NUMBER || null;
    }
    return null;
  }

  /**
   * Get connection status for an organization.
   * Results are cached for STATUS_CACHE_TTL_MS to reduce API calls.
   */
  async getConnectionStatus(
    organizationId: string,
    options?: { skipCache?: boolean },
  ): Promise<BlooioConnectionStatus> {
    // Check cache first (unless explicitly skipped)
    if (!options?.skipCache) {
      const cached = this.statusCache.get(organizationId);
      if (cached && Date.now() - cached.cachedAt < STATUS_CACHE_TTL_MS) {
        return cached.status;
      }

      const pending = this.statusRequests.get(organizationId);
      if (pending) return pending;
    }

    const request = this.loadConnectionStatus(organizationId).finally(() => {
      this.statusRequests.delete(organizationId);
    });
    if (!options?.skipCache) {
      this.statusRequests.set(organizationId, request);
    }
    return request;
  }

  private async loadConnectionStatus(organizationId: string): Promise<BlooioConnectionStatus> {
    const apiKey = await this.getApiKey(organizationId);
    const fromNumber = await this.getFromNumber(organizationId);

    if (!apiKey) {
      const status: BlooioConnectionStatus = {
        connected: false,
        configured: false,
      };
      this.statusCache.set(organizationId, { status, cachedAt: Date.now() });
      return status;
    }

    // Validate the API key is still working
    const validation = await this.validateApiKey(apiKey);

    if (validation.valid) {
      const status: BlooioConnectionStatus = {
        connected: true,
        configured: true,
        fromNumber: fromNumber || undefined,
      };
      this.statusCache.set(organizationId, { status, cachedAt: Date.now() });
      return status;
    }

    // API key exists but validation failed
    const status: BlooioConnectionStatus = {
      connected: false,
      configured: true,
      fromNumber: fromNumber || undefined,
      error: validation.error || "API key may be invalid. Try reconnecting.",
    };
    // Cache with shorter TTL for error state (1 minute)
    this.statusCache.set(organizationId, {
      status,
      cachedAt: Date.now() - STATUS_CACHE_TTL_MS + 60_000,
    });
    return status;
  }

  /**
   * Get the webhook URL for an organization.
   */
  getWebhookUrl(organizationId: string): string {
    return `${WEBHOOK_BASE_URL}/api/webhooks/blooio/${organizationId}`;
  }

  /**
   * Send a message via Blooio.
   */
  async sendMessage(
    organizationId: string,
    chatId: string,
    request: Omit<BlooioSendMessageRequest, "fromNumber">,
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
  }> {
    const apiKey = await this.getApiKey(organizationId);
    if (!apiKey) {
      return { success: false, error: "Blooio not configured" };
    }

    // Normalize and validate chat ID
    const normalizedChatId = chatId
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(",");

    if (!validateBlooioChatId(normalizedChatId)) {
      return {
        success: false,
        error:
          "Invalid chat ID. Use E.164 phone number (+15551234567), email, or group ID (grp_xxx)",
      };
    }

    try {
      const fromNumber = await this.getFromNumber(organizationId);

      const payload: Record<string, unknown> = {};
      if (request.text) payload.text = request.text;
      if (request.attachments) payload.attachments = request.attachments;
      if (request.metadata) payload.metadata = request.metadata;
      if (request.use_typing_indicator) payload.use_typing_indicator = request.use_typing_indicator;

      const response = await blooioApiRequest<BlooioSendMessageResponse>(
        apiKey,
        "POST",
        `/chats/${encodeURIComponent(normalizedChatId)}/messages`,
        payload,
        {
          fromNumber: fromNumber || undefined,
          idempotencyKey: request.idempotencyKey,
        },
      );

      const messageId =
        response.message_id || (response.message_ids ? response.message_ids[0] : undefined);

      logger.info("[BlooioAutomation] Message sent", {
        organizationId,
        chatId: normalizedChatId,
        messageId,
      });

      return { success: true, messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("[BlooioAutomation] Failed to send message", {
        organizationId,
        chatId: normalizedChatId,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Check if Blooio is configured (has stored credentials).
   */
  async isConfigured(organizationId: string): Promise<boolean> {
    const apiKey = await this.getApiKey(organizationId);
    return Boolean(apiKey);
  }
}

export const blooioAutomationService = new BlooioAutomationService();
