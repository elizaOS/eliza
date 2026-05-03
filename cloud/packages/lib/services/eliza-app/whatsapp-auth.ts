/**
 * WhatsApp Webhook Authentication Service
 *
 * Verifies incoming WhatsApp webhook signatures using HMAC-SHA256 with the App Secret.
 * Also handles the webhook verification GET handshake.
 */

import { logger } from "@/lib/utils/logger";
import { verifyWhatsAppSignature } from "@/lib/utils/whatsapp-api";
import { elizaAppConfig } from "./config";

class WhatsAppAuthService {
  /**
   * Verify the X-Hub-Signature-256 header on incoming webhook POST requests.
   *
   * @param signatureHeader - The X-Hub-Signature-256 header value
   * @param rawBody - The raw request body as a string
   * @returns true if signature is valid
   */
  verifyWebhookSignature(signatureHeader: string, rawBody: string): boolean {
    const appSecret = elizaAppConfig.whatsapp.appSecret;

    if (!appSecret) {
      logger.error("[WhatsAppAuth] App secret not configured");
      return false;
    }

    const isValid = verifyWhatsAppSignature(appSecret, signatureHeader, rawBody);

    if (!isValid) {
      logger.warn("[WhatsAppAuth] Webhook signature verification failed");
    }

    return isValid;
  }

  /**
   * Verify the webhook verification GET request from Meta.
   *
   * When setting up webhooks, Meta sends a GET request with:
   * - hub.mode: "subscribe"
   * - hub.verify_token: The verify token you configured
   * - hub.challenge: A challenge string to echo back
   *
   * @returns The challenge string if verification succeeds, null otherwise
   */
  verifyWebhookSubscription(
    mode: string | null,
    verifyToken: string | null,
    challenge: string | null,
  ): string | null {
    const expectedToken = elizaAppConfig.whatsapp.verifyToken;

    if (!expectedToken) {
      logger.error("[WhatsAppAuth] Verify token not configured");
      return null;
    }

    if (mode !== "subscribe") {
      logger.warn("[WhatsAppAuth] Invalid hub.mode", { mode });
      return null;
    }

    if (verifyToken !== expectedToken) {
      logger.warn("[WhatsAppAuth] Verify token mismatch");
      return null;
    }

    if (!challenge) {
      logger.warn("[WhatsAppAuth] Missing hub.challenge");
      return null;
    }

    logger.info("[WhatsAppAuth] Webhook verification successful");
    return challenge;
  }
}

export const whatsAppAuthService = new WhatsAppAuthService();
