import type { IAgentRuntime } from "@elizaos/core";
import {
  acknowledgeIntent,
  type LifeOpsIntent,
  type LifeOpsIntentTargetDevice,
  pruneExpiredIntents,
  receivePendingIntents,
} from "./intent-sync.js";

/**
 * Service-layer wrappers around the local intent store. The agent-facing
 * action exposes only the broadcast flow (OWNER_DEVICE_INTENT); these
 * helpers cover the management operations that used to live as INTENT_SYNC
 * subactions and are now invoked directly by callers.
 */

export async function acknowledgeDeviceIntent(
  runtime: IAgentRuntime,
  intentId: string,
  deviceId: string,
): Promise<void> {
  await acknowledgeIntent(runtime, intentId, deviceId);
}

export async function pruneExpiredDeviceIntents(
  runtime: IAgentRuntime,
): Promise<{ pruned: number }> {
  return pruneExpiredIntents(runtime);
}

export async function listPendingDeviceIntents(
  runtime: IAgentRuntime,
  opts?: {
    device?: LifeOpsIntentTargetDevice;
    deviceId?: string;
    limit?: number;
  },
): Promise<LifeOpsIntent[]> {
  return receivePendingIntents(runtime, opts);
}
