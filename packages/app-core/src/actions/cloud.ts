/**
 * Cloud action helpers — extracted from AppContext.
 *
 * Pure functions for Eliza Cloud status polling and credit management.
 */

import type { ElizaClient } from "../api/client";

export interface CloudStatusResult {
  enabled: boolean;
  connected: boolean;
  userId: string | null;
  topUpUrl: string | null;
  credits: number | null;
  creditsLow: boolean;
  creditsCritical: boolean;
}

export async function pollCloudStatus(
  client: ElizaClient,
): Promise<CloudStatusResult> {
  const cloudStatus = await client.getCloudStatus().catch(() => null);
  if (!cloudStatus) {
    return {
      enabled: false,
      connected: false,
      userId: null,
      topUpUrl: null,
      credits: null,
      creditsLow: false,
      creditsCritical: false,
    };
  }

  const isConnected = Boolean(cloudStatus.connected || cloudStatus.hasApiKey);
  const result: CloudStatusResult = {
    enabled: Boolean(cloudStatus.enabled ?? false),
    connected: isConnected,
    userId: cloudStatus.userId ?? null,
    topUpUrl: cloudStatus.topUpUrl ?? null,
    credits: null,
    creditsLow: false,
    creditsCritical: false,
  };

  if (isConnected) {
    const credits = await client.getCloudCredits().catch(() => null);
    if (credits && typeof credits.balance === "number") {
      result.credits = credits.balance;
      result.creditsLow = credits.low ?? false;
      result.creditsCritical = credits.critical ?? false;
      if (credits.topUpUrl) result.topUpUrl = credits.topUpUrl;
    } else if (credits?.topUpUrl) {
      result.topUpUrl = credits.topUpUrl;
    }
  }

  return result;
}
