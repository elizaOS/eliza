// Stable connector-account identity shared by delivery dedupe and provenance forwarding.
import { createHash } from "node:crypto";
import type { Platform, WebhookConfig } from "./adapters/types";

export function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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
    case "telegram":
      return config.botToken
        ? `bot:${credentialFingerprint(config.botToken)}`
        : undefined;
    case "whatsapp":
      return config.phoneNumberId ?? config.businessPhone;
    case "twilio":
      return config.phoneNumber ?? config.accountSid;
    case "blooio":
      return config.fromNumber;
  }
}
