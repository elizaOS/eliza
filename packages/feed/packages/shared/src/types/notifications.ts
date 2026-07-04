/**
 * Notification transport types: digest delivery settings and the per-event data
 * payloads (market resolution, performance digest, achievement/challenge rewards)
 * carried on a stored notification.
 */
import type {
  AchievementUnlockedNotificationData,
  ChallengeCompletedNotificationData,
} from "../utils/reward-notifications";
import type { JsonValue } from "./common";

export type NotificationDigestFrequency = "hourly" | "daily" | "weekly";

export type NotificationDeliveryChannel = "in-app" | "email" | "both";

export interface NotificationDigestSettings {
  digestEnabled: boolean;
  frequency: NotificationDigestFrequency;
  deliveryChannel: NotificationDeliveryChannel;
}

export const DEFAULT_NOTIFICATION_DIGEST_SETTINGS: NotificationDigestSettings =
  {
    digestEnabled: true,
    frequency: "daily",
    deliveryChannel: "both",
  };

export interface MarketResolvedNotificationData {
  marketId: string;
  marketName: string;
  outcome: "win" | "loss";
  points: number;
  agentName?: string;
  deepLink: string;
}

export interface PerformanceDigestNotificationData {
  frequency: NotificationDigestFrequency;
  periodStart: string;
  periodEnd: string;
  netPointsChange: number;
  marketsWon: number;
  marketsLost: number;
  topPerformingAgent: {
    name: string;
    points: number;
  } | null;
  summary: string;
}

export type NotificationData =
  | JsonValue
  | MarketResolvedNotificationData
  | PerformanceDigestNotificationData
  | AchievementUnlockedNotificationData
  | ChallengeCompletedNotificationData;
