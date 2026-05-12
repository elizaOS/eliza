import type { IAgentRuntime } from "@elizaos/core";
import {
  acknowledgeIntent,
  type LifeOpsIntent,
  type LifeOpsIntentTargetDevice,
  pruneExpiredIntents,
  receivePendingIntents,
} from "./intent-sync.js";

/**
 * Service-layer wrappers around the local intent store. These helpers
 * cover the management operations invoked directly by callers.
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
