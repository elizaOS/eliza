/**
 * WhatsApp Automation Service
 *
 * Handles credential validation, storage, and message management
 * for WhatsApp Business Cloud API integration at the organization level.
 * Follows the Blooio/Telegram automation service pattern.
 *
 * Each organization connects their own WhatsApp Business account
 * with credentials stored in the secrets service.
 */

import crypto from "crypto";
import { cache } from "@/lib/cache/client";
import {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_APP_SECRET,
  WHATSAPP_BUSINESS_PHONE,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} from "@/lib/constants/secrets";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import {
  sendWhatsAppMessage,
  verifyWhatsAppSignature,
  WHATSAPP_API_BASE,
} from "@/lib/utils/whatsapp-api";

// Use ELIZA_API_URL (ngrok) for local dev webhooks, otherwise NEXT_PUBLIC_APP_URL
const WEBHOOK_BASE_URL =
  process.env.ELIZA_API_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

const META_REQUEST_TIMEOUT_MS = 10_000;
const STATUS_CACHE_TTL_SECONDS = 5 * 60;
const STATUS_ERROR_CACHE_TTL_SECONDS = 60;

export interface WhatsAppConnectionStatus {
  connected: boolean;
  configured: boolean;
  businessPhone?: string;
  error?: string;
}

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken?: string; // Auto-generated if not provided
  businessPhone?: string;
}

class WhatsAppAutomationService {
  private getStatusCacheKey(organizationId: string): string {
    return `whatsapp:connection-status:${organizationId}`;
  }

  /**
   * Invalidate cached status for an organization.
   */
  invalidateStatusCache(organizationId: string): void {
    void cache.del(this.getStatusCacheKey(organizationId));
  }

  /**
   * Generate a random verify token for webhook handshake.
   * Used when registering the webhook URL in Meta App Dashboard.
   */
  generateVerifyToken(): string {
    return `wa_verify_${crypto.randomBytes(24).toString("hex")}`;
  }

  /**
   * Validate a WhatsApp access token by calling Meta Graph API.
   * Fetches the phone number ID details to confirm the token works.
   */
  async validateAccessToken(
    accessToken: string,
    phoneNumberId: string,
  ): Promise<{
    valid: boolean;
    phoneDisplay?: string;
    error?: string;
  }> {
    if (!accessToken || accessToken.trim() === "") {
      return { valid: false, error: "Access token is required" };
    }
    if (!phoneNumberId || phoneNumberId.trim() === "") {
      return { valid: false, error: "Phone Number ID is required" };
    }

    try {
      // Validate by fetching phone number details from Meta Graph API
      const url = `${WHATSAPP_API_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          return { valid: false, error: "Invalid access token" };
        }
        if (response.status === 400) {
          return { valid: false, error: "Invalid Phone Number ID" };
        }
        logger.warn("[WhatsAppAutomation] Token validation failed", {
          status: response.status,
          error: errorText.slice(0, 200),
        });
        return {
          valid: false,
          error: "Validation failed. Please check your credentials.",
        };
      }

      const data = (await response.json()) as {
        display_phone_number?: string;
        verified_name?: string;
      };

      logger.info("[WhatsAppAutomation] Access token validated successfully", {
        phoneNumberId,
        displayPhone: data.display_phone_number,
        verifiedName: data.verified_name,
      });

      return {
        valid: true,
        phoneDisplay: data.display_phone_number,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn("[WhatsAppAutomation] Token validation error", {
        error: message,
      });
      return {
        valid: false,
        error: "Validation failed due to network error. Please try again.",
      };
    }
  }

  /**
   * Store WhatsApp credentials in the secrets service.
   * Handles the case where secrets already exist by updating them.
   */
  async storeCredentials(
    organizationId: string,
    userId: string,
    credentials: WhatsAppCredentials,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "whatsapp-automation",
    };
    const verifyToken = credentials.verifyToken || this.generateVerifyToken();
    const secretEntries = [
      [WHATSAPP_ACCESS_TOKEN, credentials.accessToken],
      [WHATSAPP_PHONE_NUMBER_ID, credentials.phoneNumberId],
      [WHATSAPP_APP_SECRET, credentials.appSecret],
      [WHATSAPP_VERIFY_TOKEN, verifyToken],
      ...(credentials.businessPhone
        ? [[WHATSAPP_BUSINESS_PHONE, credentials.businessPhone] as const]
        : []),
    ] as const;

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
          logger.info("[WhatsAppAutomation] Secret exists, updating", { name });
          const existingSecrets = await secretsService.list(organizationId);
          const existingSecret = existingSecrets.find((s) => s.name === name);
          if (existingSecret) {
            await secretsService.rotate(existingSecret.id, organizationId, value, audit);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    };

    const previousValueEntries = await Promise.all(
      secretEntries.map(
        async ([name]): Promise<[string, string | null]> => [
          name,
          await secretsService.get(organizationId, name),
        ],
      ),
    );
    const previousValues = new Map<string, string | null>(previousValueEntries);

    try {
      for (const [name, value] of secretEntries) {
        await createOrUpdateSecret(name, value);
      }
    } catch (error) {
      logger.error("[WhatsAppAutomation] Failed to store credentials, rolling back", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });

      await Promise.allSettled(
        secretEntries.map(async ([name]) => {
          const previousValue = previousValues.get(name);
          if (previousValue) {
            await createOrUpdateSecret(name, previousValue);
            return;
          }

          await secretsService.deleteByName(organizationId, name, audit);
        }),
      );

      throw error;
    }

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[WhatsAppAutomation] Credentials stored", {
      organizationId,
      hasBusinessPhone: !!credentials.businessPhone,
    });
  }

  /**
   * Remove WhatsApp credentials (disconnect).
   */
  async removeCredentials(organizationId: string, userId: string): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "whatsapp-automation",
    };

    const secretNames = [
      WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_APP_SECRET,
      WHATSAPP_VERIFY_TOKEN,
      WHATSAPP_BUSINESS_PHONE,
    ];

    // Get all secrets once (not inside the loop) for efficiency
    const existingSecrets = await secretsService.list(organizationId);

    for (const name of secretNames) {
      const secret = existingSecrets.find((s) => s.name === name);
      if (secret) {
        await secretsService.delete(secret.id, organizationId, audit);
        logger.info("[WhatsAppAutomation] Deleted secret", {
          name,
          organizationId,
        });
      }
    }

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[WhatsAppAutomation] Credentials removed", { organizationId });
  }

  /**
   * Get access token for an organization.
   * No env fallback in production to prevent multi-tenancy violation.
   */
  async getAccessToken(organizationId: string): Promise<string | null> {
    const fromSecrets = await secretsService.get(organizationId, WHATSAPP_ACCESS_TOKEN);
    if (fromSecrets) return fromSecrets;
    if (process.env.NODE_ENV !== "production") {
      return process.env.WHATSAPP_ACCESS_TOKEN || null;
    }
    return null;
  }

  /**
   * Get phone number ID for an organization.
   */
  async getPhoneNumberId(organizationId: string): Promise<string | null> {
    const fromSecrets = await secretsService.get(organizationId, WHATSAPP_PHONE_NUMBER_ID);
    if (fromSecrets) return fromSecrets;
    if (process.env.NODE_ENV !== "production") {
      return process.env.WHATSAPP_PHONE_NUMBER_ID || null;
    }
    return null;
  }

  /**
   * Get app secret for an organization.
   */
  async getAppSecret(organizationId: string): Promise<string | null> {
    const fromSecrets = await secretsService.get(organizationId, WHATSAPP_APP_SECRET);
    if (fromSecrets) return fromSecrets;
    if (process.env.NODE_ENV !== "production") {
      return process.env.WHATSAPP_APP_SECRET || null;
    }
    return null;
  }

  /**
   * Get verify token for an organization.
   */
  async getVerifyToken(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, WHATSAPP_VERIFY_TOKEN);
  }

  /**
   * Get business phone for an organization (display purposes).
   */
  async getBusinessPhone(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, WHATSAPP_BUSINESS_PHONE);
  }

  /**
   * Verify a webhook signature using an organization's app secret.
   */
  async verifyWebhookSignature(
    organizationId: string,
    signatureHeader: string,
    rawBody: string,
  ): Promise<boolean> {
    const appSecret = await this.getAppSecret(organizationId);
    if (!appSecret) {
      logger.warn("[WhatsAppAutomation] No app secret configured", {
        organizationId,
      });
      return false;
    }
    return verifyWhatsAppSignature(appSecret, signatureHeader, rawBody);
  }

  /**
   * Verify a webhook subscription handshake using an organization's verify token.
   */
  async verifyWebhookSubscription(
    organizationId: string,
    mode: string | null,
    verifyToken: string | null,
    challenge: string | null,
  ): Promise<string | null> {
    if (mode !== "subscribe" || !verifyToken || !challenge) {
      return null;
    }

    const storedToken = await this.getVerifyToken(organizationId);
    if (!storedToken || verifyToken !== storedToken) {
      return null;
    }

    return challenge;
  }

  /**
   * Get connection status for an organization.
   * Results are cached in Redis when available to reduce Meta API calls across
   * serverless instances.
   */
  async getConnectionStatus(
    organizationId: string,
    options?: { skipCache?: boolean },
  ): Promise<WhatsAppConnectionStatus> {
    // Check cache first (unless explicitly skipped)
    if (!options?.skipCache) {
      const cached = await cache.get<WhatsAppConnectionStatus>(
        this.getStatusCacheKey(organizationId),
      );
      if (cached) {
        return cached;
      }
    }

    const [accessToken, phoneNumberId, businessPhone] = await Promise.all([
      this.getAccessToken(organizationId),
      this.getPhoneNumberId(organizationId),
      this.getBusinessPhone(organizationId),
    ]);

    if (!accessToken || !phoneNumberId) {
      const status: WhatsAppConnectionStatus = {
        connected: false,
        configured: false,
      };
      await cache.set(this.getStatusCacheKey(organizationId), status, STATUS_CACHE_TTL_SECONDS);
      return status;
    }

    // Validate the access token is still working
    const validation = await this.validateAccessToken(accessToken, phoneNumberId);

    if (validation.valid) {
      const status: WhatsAppConnectionStatus = {
        connected: true,
        configured: true,
        businessPhone: businessPhone || validation.phoneDisplay || undefined,
      };
      await cache.set(this.getStatusCacheKey(organizationId), status, STATUS_CACHE_TTL_SECONDS);
      return status;
    }

    // Token exists but validation failed (expired or revoked)
    const status: WhatsAppConnectionStatus = {
      connected: false,
      configured: true,
      businessPhone: businessPhone || undefined,
      error: validation.error || "Access token may be invalid. Try reconnecting.",
    };
    await cache.set(this.getStatusCacheKey(organizationId), status, STATUS_ERROR_CACHE_TTL_SECONDS);
    return status;
  }

  /**
   * Get the webhook URL for an organization.
   */
  getWebhookUrl(organizationId: string): string {
    return `${WEBHOOK_BASE_URL}/api/webhooks/whatsapp/${organizationId}`;
  }

  /**
   * Send a text message via WhatsApp using organization-specific credentials.
   */
  async sendMessage(
    organizationId: string,
    to: string,
    text: string,
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
  }> {
    const [accessToken, phoneNumberId] = await Promise.all([
      this.getAccessToken(organizationId),
      this.getPhoneNumberId(organizationId),
    ]);

    if (!accessToken || !phoneNumberId) {
      return { success: false, error: "WhatsApp not configured" };
    }

    try {
      const response = await sendWhatsAppMessage(accessToken, phoneNumberId, to, text);
      const messageId = response.messages?.[0]?.id;

      logger.info("[WhatsAppAutomation] Message sent", {
        organizationId,
        to,
        messageId,
      });

      return { success: true, messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("[WhatsAppAutomation] Failed to send message", {
        organizationId,
        to,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Check if WhatsApp is configured (has stored credentials).
   */
  async isConfigured(organizationId: string): Promise<boolean> {
    const accessToken = await this.getAccessToken(organizationId);
    return Boolean(accessToken);
  }
}

export const whatsappAutomationService = new WhatsAppAutomationService();
