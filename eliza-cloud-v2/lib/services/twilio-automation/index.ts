/**
 * Twilio Automation Service
 *
 * Handles credential validation, storage, and SMS/MMS message management
 * for Twilio integration. Follows the same pattern as Telegram and Blooio.
 */

import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import {
  twilioApiRequest,
  isE164PhoneNumber,
  type TwilioSendMessageRequest,
  type TwilioSendMessageResponse,
} from "@/lib/utils/twilio-api";

// Use ELIZA_API_URL (ngrok) for local dev webhooks, otherwise NEXT_PUBLIC_APP_URL
const WEBHOOK_BASE_URL =
  process.env.ELIZA_API_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://eliza.gg";

// Cache TTL for connection status (5 minutes)
const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedStatus {
  status: TwilioConnectionStatus;
  cachedAt: number;
}

export interface TwilioConnectionStatus {
  connected: boolean;
  configured: boolean;
  phoneNumber?: string;
  error?: string;
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

class TwilioAutomationService {
  // In-memory cache for connection status
  private statusCache = new Map<string, CachedStatus>();

  /**
   * Invalidate cached status for an organization.
   */
  invalidateStatusCache(organizationId: string): void {
    this.statusCache.delete(organizationId);
  }

  /**
   * Validate Twilio credentials by fetching account info.
   */
  async validateCredentials(
    accountSid: string,
    authToken: string,
  ): Promise<{
    valid: boolean;
    accountName?: string;
    error?: string;
  }> {
    if (!accountSid || !authToken) {
      return { valid: false, error: "Account SID and Auth Token are required" };
    }

    try {
      // Fetch account info to validate credentials
      const account = await twilioApiRequest<{
        friendly_name: string;
        status: string;
      }>(accountSid, authToken, "GET", ".json");

      if (account.status !== "active") {
        return {
          valid: false,
          error: `Twilio account is ${account.status}, not active`,
        };
      }

      logger.info("[TwilioAutomation] Credentials validated successfully", {
        accountName: account.friendly_name,
      });

      return { valid: true, accountName: account.friendly_name };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn("[TwilioAutomation] Credentials validation failed", {
        error: message,
      });
      return { valid: false, error: message };
    }
  }

  /**
   * Store Twilio credentials in the secrets service.
   * Handles the case where secrets already exist by updating them.
   */
  async storeCredentials(
    organizationId: string,
    userId: string,
    credentials: TwilioCredentials,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "twilio-automation",
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
          logger.info("[TwilioAutomation] Secret exists, updating", { name });
          const existingSecrets = await secretsService.list(organizationId);
          const existingSecret = existingSecrets.find((s) => s.name === name);
          if (existingSecret) {
            await secretsService.rotate(
              existingSecret.id,
              organizationId,
              value,
              audit,
            );
          } else {
            throw err; // Re-throw if we can't find it
          }
        } else {
          throw err;
        }
      }
    };

    await createOrUpdateSecret("TWILIO_ACCOUNT_SID", credentials.accountSid);
    await createOrUpdateSecret("TWILIO_AUTH_TOKEN", credentials.authToken);
    await createOrUpdateSecret("TWILIO_PHONE_NUMBER", credentials.phoneNumber);

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[TwilioAutomation] Credentials stored", {
      organizationId,
      phoneNumber: credentials.phoneNumber,
    });
  }

  /**
   * Remove Twilio credentials (disconnect).
   */
  async removeCredentials(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "twilio-automation",
    };

    const secretNames = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
    ];

    // Get all secrets once (not inside the loop) for efficiency
    const existingSecrets = await secretsService.list(organizationId);

    // Delete each secret by finding it in the cached list
    for (const name of secretNames) {
      const secret = existingSecrets.find((s) => s.name === name);
      if (secret) {
        await secretsService.delete(secret.id, organizationId, audit);
        logger.info("[TwilioAutomation] Deleted secret", {
          name,
          organizationId,
        });
      }
    }

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[TwilioAutomation] Credentials removed", { organizationId });
  }

  /**
   * Get Account SID for an organization.
   */
  async getAccountSid(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, "TWILIO_ACCOUNT_SID");
  }

  /**
   * Get Auth Token for an organization.
   */
  async getAuthToken(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, "TWILIO_AUTH_TOKEN");
  }

  /**
   * Get phone number for an organization.
   */
  async getPhoneNumber(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, "TWILIO_PHONE_NUMBER");
  }

  /**
   * Get connection status for an organization.
   * Results are cached for STATUS_CACHE_TTL_MS to reduce API calls.
   */
  async getConnectionStatus(
    organizationId: string,
    options?: { skipCache?: boolean },
  ): Promise<TwilioConnectionStatus> {
    // Check cache first (unless explicitly skipped)
    if (!options?.skipCache) {
      const cached = this.statusCache.get(organizationId);
      if (cached && Date.now() - cached.cachedAt < STATUS_CACHE_TTL_MS) {
        return cached.status;
      }
    }

    const [accountSid, authToken, phoneNumber] = await Promise.all([
      this.getAccountSid(organizationId),
      this.getAuthToken(organizationId),
      this.getPhoneNumber(organizationId),
    ]);

    if (!accountSid || !authToken) {
      const status: TwilioConnectionStatus = {
        connected: false,
        configured: false,
      };
      this.statusCache.set(organizationId, { status, cachedAt: Date.now() });
      return status;
    }

    // Validate the credentials are still working
    const validation = await this.validateCredentials(accountSid, authToken);

    if (validation.valid) {
      const status: TwilioConnectionStatus = {
        connected: true,
        configured: true,
        phoneNumber: phoneNumber || undefined,
      };
      this.statusCache.set(organizationId, { status, cachedAt: Date.now() });
      return status;
    }

    // Credentials exist but validation failed
    const status: TwilioConnectionStatus = {
      connected: false,
      configured: true,
      phoneNumber: phoneNumber || undefined,
      error: validation.error || "Credentials may be invalid. Try reconnecting.",
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
    return `${WEBHOOK_BASE_URL}/api/webhooks/twilio/${organizationId}`;
  }

  /**
   * Send an SMS/MMS message via Twilio.
   */
  async sendMessage(
    organizationId: string,
    request: TwilioSendMessageRequest,
  ): Promise<{
    success: boolean;
    messageSid?: string;
    error?: string;
  }> {
    const [accountSid, authToken, fromNumber] = await Promise.all([
      this.getAccountSid(organizationId),
      this.getAuthToken(organizationId),
      this.getPhoneNumber(organizationId),
    ]);

    if (!accountSid || !authToken || !fromNumber) {
      return { success: false, error: "Twilio not configured" };
    }

    // Validate phone number format
    if (!isE164PhoneNumber(request.to)) {
      return {
        success: false,
        error: "Invalid phone number format. Use E.164 format (+15551234567)",
      };
    }

    try {
      const params = new URLSearchParams();
      params.append("To", request.to);
      params.append("From", fromNumber);

      if (request.body) {
        params.append("Body", request.body);
      }

      if (request.mediaUrl) {
        for (const url of request.mediaUrl) {
          params.append("MediaUrl", url);
        }
      }

      if (request.statusCallback) {
        params.append("StatusCallback", request.statusCallback);
      }

      const response = await twilioApiRequest<TwilioSendMessageResponse>(
        accountSid,
        authToken,
        "POST",
        "/Messages.json",
        params,
      );

      logger.info("[TwilioAutomation] Message sent", {
        organizationId,
        to: request.to,
        messageSid: response.sid,
        status: response.status,
      });

      return { success: true, messageSid: response.sid };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("[TwilioAutomation] Failed to send message", {
        organizationId,
        to: request.to,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Check if Twilio is configured (has stored credentials).
   */
  async isConfigured(organizationId: string): Promise<boolean> {
    const [accountSid, authToken] = await Promise.all([
      this.getAccountSid(organizationId),
      this.getAuthToken(organizationId),
    ]);
    return Boolean(accountSid && authToken);
  }
}

export const twilioAutomationService = new TwilioAutomationService();
