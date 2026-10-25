/** Defines the transport-neutral mobile-push records shared by Cloud registration and delivery. */

export type MobilePushPlatform = "ios" | "android";

/** Maximum normalized token length accepted by every Cloud push authority boundary. */
export const MAX_MOBILE_PUSH_TOKEN_CHARACTERS = 4_096;

export interface MobilePushTokenRecord {
  token: string;
  platform: MobilePushPlatform;
  createdAt: number;
}

export interface MobilePushMessage {
  title: string;
  body?: string;
  /** Stable occurrence key that APNs hashes into its bounded collapse header. */
  collapseKey?: string;
  data?: Record<string, string | number | boolean | null>;
}

export type MobilePushDeliveryResult =
  | { outcome: "accepted"; apnsId?: string }
  | {
      outcome: "unregistered";
      reason: "Unregistered" | "BadDeviceToken" | "ExpiredToken";
    }
  | { outcome: "rejected"; status: number; reason?: string };
