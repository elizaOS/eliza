/**
 * Claims durable post-link greetings from cloud and delivers them through the
 * gateway's receipt-backed Telegram and phone connectors.
 */

import { deliverInternalMessage } from "./internal-delivery";
import type { GatewayRedis } from "./redis";

export type WebhookGreetingPlatform = "telegram" | "blooio" | "twilio";

interface PendingGreeting {
  sessionId?: string;
  platformUserId?: string;
  message?: string;
  leaseId?: string;
  deliveryNonce?: string;
}

export interface WebhookGreetingDeliveryReport {
  claimed: number;
  delivered: number;
  malformed: number;
  retainedForRetry: number;
  acknowledged: number;
  authRefreshNeeded: boolean;
}

const PLATFORMS: readonly WebhookGreetingPlatform[] = [
  "telegram",
  "blooio",
  "twilio",
];

function parseGreetings(value: unknown): PendingGreeting[] {
  if (!value || typeof value !== "object") return [];
  const greetings = (value as { greetings?: unknown }).greetings;
  return Array.isArray(greetings)
    ? greetings.filter(
        (entry): entry is PendingGreeting =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function isDeliverable(
  entry: PendingGreeting,
  platform: WebhookGreetingPlatform,
): entry is Required<PendingGreeting> {
  const identityValid =
    platform === "telegram"
      ? /^-?\d{1,20}$/.test(entry.platformUserId ?? "")
      : /^\+[1-9]\d{6,14}$/.test(entry.platformUserId ?? "");
  return Boolean(
    identityValid &&
      entry.sessionId &&
      entry.sessionId.length >= 8 &&
      entry.sessionId.length <= 180 &&
      entry.message?.trim() &&
      entry.message.length <= 2000 &&
      entry.leaseId &&
      /^[A-Za-z0-9_-]{1,25}$/.test(entry.leaseId) &&
      entry.deliveryNonce &&
      /^[A-Za-z0-9_-]{1,25}$/.test(entry.deliveryNonce),
  );
}

/** Runs one bounded claim/deliver/ack pass for every webhook-owned platform. */
export async function drainAndDeliverWebhookGreetings(options: {
  redis: GatewayRedis;
  claim: (platform: WebhookGreetingPlatform) => Promise<Response>;
  acknowledge: (
    platform: WebhookGreetingPlatform,
    acknowledgements: Array<{ sessionId: string; leaseId: string }>,
  ) => Promise<Response>;
  deliver?: typeof deliverInternalMessage;
}): Promise<WebhookGreetingDeliveryReport> {
  const report: WebhookGreetingDeliveryReport = {
    claimed: 0,
    delivered: 0,
    malformed: 0,
    retainedForRetry: 0,
    acknowledged: 0,
    authRefreshNeeded: false,
  };
  const deliver = options.deliver ?? deliverInternalMessage;

  for (const platform of PLATFORMS) {
    const claimed = await options.claim(platform);
    if (claimed.status === 401) {
      report.authRefreshNeeded = true;
      continue;
    }
    if (!claimed.ok) continue;
    const entries = parseGreetings(await claimed.json());
    report.claimed += entries.length;
    const acknowledgements: Array<{ sessionId: string; leaseId: string }> = [];
    for (const entry of entries) {
      if (!isDeliverable(entry, platform)) {
        report.malformed += 1;
        if (entry.sessionId && entry.leaseId) {
          acknowledgements.push({
            sessionId: entry.sessionId,
            leaseId: entry.leaseId,
          });
        }
        continue;
      }
      const payload = {
        platform,
        project: "eliza-app",
        ...(platform === "telegram"
          ? { chatId: entry.platformUserId }
          : { phoneNumber: entry.platformUserId }),
        text: entry.message,
        idempotencyKey: `onboarding:${entry.deliveryNonce}`,
      };
      const response = await deliver(
        new Request("https://gateway.internal/internal/deliver", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        { redis: options.redis },
      );
      // A completed receipt or indeterminate acceptance must never be retried;
      // retrying an acceptance-unknown Telegram/Twilio send can duplicate it.
      if (response.ok || response.status === 202) {
        report.delivered += 1;
        acknowledgements.push({
          sessionId: entry.sessionId,
          leaseId: entry.leaseId,
        });
      } else {
        report.retainedForRetry += 1;
      }
    }
    if (acknowledgements.length === 0) continue;
    const acknowledged = await options.acknowledge(platform, acknowledgements);
    if (!acknowledged.ok) continue;
    const body = (await acknowledged.json()) as { acknowledged?: unknown };
    if (typeof body.acknowledged === "number") {
      report.acknowledged += body.acknowledged;
    }
  }
  return report;
}
