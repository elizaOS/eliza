/** Defines the transport-neutral mobile-push records shared by Cloud registration and delivery. */

export type MobilePushPlatform = "ios" | "android";

export interface MobilePushTokenRecord {
  token: string;
  platform: MobilePushPlatform;
  createdAt: number;
}

export interface MobilePushMessage {
  title: string;
  body?: string;
  data?: Record<string, string | number | boolean | null>;
}

export type MobilePushDeliveryResult =
  | { outcome: "accepted"; apnsId?: string }
  | { outcome: "unregistered"; reason: "Unregistered" | "BadDeviceToken" }
  | { outcome: "rejected"; status: number; reason?: string };
