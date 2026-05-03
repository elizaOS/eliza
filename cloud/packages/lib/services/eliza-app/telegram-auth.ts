/**
 * Telegram Login Widget Authentication Service
 *
 * Verifies authentication data from Telegram Login Widget using HMAC-SHA256.
 * See: https://core.telegram.org/widgets/login#checking-authorization
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { logger } from "@/lib/utils/logger";
import { elizaAppConfig } from "./config";

/**
 * Data returned by Telegram Login Widget
 */
export interface TelegramAuthData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * Maximum age for auth_date in seconds (24 hours)
 * Prevents replay attacks with old authentication data
 */
const MAX_AUTH_AGE_SECONDS = 86400;

class TelegramAuthService {
  private getBotToken() {
    return elizaAppConfig.telegram.botToken;
  }

  private getSecretKey(botToken: string) {
    return createHash("sha256").update(botToken).digest();
  }

  /**
   * Verify Telegram Login Widget authentication data.
   *
   * Algorithm:
   * 1. Create data-check-string by sorting fields alphabetically (excluding hash)
   * 2. Compute HMAC-SHA256(data-check-string, SHA256(bot_token))
   * 3. Compare with provided hash
   *
   * @param data - The authentication data from Telegram Login Widget
   * @returns true if authentication is valid, false otherwise
   */
  verifyAuth(data: TelegramAuthData): boolean {
    const botToken = this.getBotToken();
    if (!botToken) {
      logger.error("[TelegramAuth] Bot token not configured");
      return false;
    }

    // Check auth_date is not too old (prevent replay attacks)
    const currentTime = Math.floor(Date.now() / 1000);
    const authAge = currentTime - data.auth_date;

    if (authAge > MAX_AUTH_AGE_SECONDS) {
      logger.warn("[TelegramAuth] Auth data too old", {
        authAge,
        maxAge: MAX_AUTH_AGE_SECONDS,
        authDate: data.auth_date,
      });
      return false;
    }

    if (authAge < 0) {
      logger.warn("[TelegramAuth] Auth date is in the future", {
        authDate: data.auth_date,
        currentTime,
      });
      return false;
    }

    // Generate the data-check-string
    const checkString = this.generateCheckString(data);

    // Compute HMAC-SHA256
    const computedHash = createHmac("sha256", this.getSecretKey(botToken))
      .update(checkString)
      .digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    const providedHashBuffer = Buffer.from(data.hash, "hex");
    const computedHashBuffer = Buffer.from(computedHash, "hex");

    if (providedHashBuffer.length !== computedHashBuffer.length) {
      logger.warn("[TelegramAuth] Hash length mismatch");
      return false;
    }

    const isValid = timingSafeEqual(providedHashBuffer, computedHashBuffer);

    if (!isValid) {
      logger.warn("[TelegramAuth] Hash verification failed", {
        telegramId: data.id,
        username: data.username,
      });
    }

    return isValid;
  }

  /**
   * Generate the data-check-string for verification.
   * Fields are sorted alphabetically and joined with newlines.
   * The hash field is excluded from the check string.
   */
  private generateCheckString(data: Omit<TelegramAuthData, "hash"> & { hash?: string }): string {
    const entries: [string, string | number][] = [];

    // Add all fields except hash, only if they have values
    if (data.auth_date !== undefined) {
      entries.push(["auth_date", data.auth_date]);
    }
    if (data.first_name !== undefined) {
      entries.push(["first_name", data.first_name]);
    }
    if (data.id !== undefined) {
      entries.push(["id", data.id]);
    }
    if (data.last_name !== undefined) {
      entries.push(["last_name", data.last_name]);
    }
    if (data.photo_url !== undefined) {
      entries.push(["photo_url", data.photo_url]);
    }
    if (data.username !== undefined) {
      entries.push(["username", data.username]);
    }

    // Sort alphabetically by key
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Join as key=value pairs separated by newlines
    return entries.map(([key, value]) => `${key}=${value}`).join("\n");
  }

  /**
   * Extract user display name from Telegram auth data.
   */
  getDisplayName(data: TelegramAuthData): string {
    if (data.last_name) {
      return `${data.first_name} ${data.last_name}`;
    }
    return data.first_name;
  }
}

export const telegramAuthService = new TelegramAuthService();
