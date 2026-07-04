/**
 * Runtime type guards narrowing untrusted DB/external strings to the
 * NotificationDigestFrequency and NotificationDeliveryChannel unions.
 */
import type {
  NotificationDeliveryChannel,
  NotificationDigestFrequency,
} from "../../types/notifications";

export const VALID_DIGEST_FREQUENCIES = new Set<string>([
  "hourly",
  "daily",
  "weekly",
]);

export const VALID_DELIVERY_CHANNELS = new Set<string>([
  "in-app",
  "email",
  "both",
]);

/**
 * Defensive check for DB / external values that should match NotificationDigestFrequency.
 */
export function isValidDigestFrequency(
  value: unknown,
): value is NotificationDigestFrequency {
  return typeof value === "string" && VALID_DIGEST_FREQUENCIES.has(value);
}

/**
 * Defensive check for DB / external values that should match NotificationDeliveryChannel.
 */
export function isValidDeliveryChannel(
  value: unknown,
): value is NotificationDeliveryChannel {
  return typeof value === "string" && VALID_DELIVERY_CHANNELS.has(value);
}
