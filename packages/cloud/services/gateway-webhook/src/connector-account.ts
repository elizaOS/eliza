/** Provides stable, non-secret connector-account identities for dedupe and provenance. */
import { createHash } from "node:crypto";
import type { Platform, WebhookConfig } from "./adapters/types";

export function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Return a stable, non-secret account id for the connector configuration.
 * Telegram tokens are credentials, so only their fingerprint may cross the
 * gateway boundary or enter Redis keys and stored provenance.
 */
export function resolveConnectorAccountId(
  platform: Platform,
  config: WebhookConfig,
): string | undefined {
  switch (platform) {
    case "telegram": {
      if (!config.botToken) return undefined;
      // Telegram documents the decimal prefix as the immutable bot user id.
      // Token rotation changes only the credential suffix, so binding durable
      // group ownership to a full-token fingerprint would silently orphan
      // every group after a routine security rotation. Keep the fingerprint
      // fallback solely for nonstandard test/proxy credentials.
      const botId = config.botToken.match(/^(\d{1,20}):/)?.[1];
      return botId
        ? `bot:${botId}`
        : `bot:${credentialFingerprint(config.botToken)}`;
    }
    case "whatsapp":
      return config.phoneNumberId ?? config.businessPhone;
    case "twilio":
      return config.phoneNumber ?? config.accountSid;
    case "blooio":
      return config.fromNumber;
  }
}
