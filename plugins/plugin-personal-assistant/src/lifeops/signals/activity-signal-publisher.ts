/**
 * Bridges persisted LifeOps activity signals onto the in-memory activity bus.
 * The SQL activity-signal table is the durable source of truth, while gates
 * and completion checks read the bus for low-latency suppression decisions.
 * Only message-activity signals are mirrored here; health-derived families have
 * their own publisher because they are produced from circadian transitions.
 */

import type { LifeOpsActivitySignal } from "@elizaos/shared";
import { mapSignalToTelemetryPayload } from "../telemetry-mapping.js";
import type { ActivitySignalBus } from "./bus.js";

export interface PublishActivitySignalResult {
  published: number;
  unmapped: number;
}

export function publishActivitySignalToBus(
  bus: ActivitySignalBus,
  signal: LifeOpsActivitySignal,
): PublishActivitySignalResult {
  const payload = mapSignalToTelemetryPayload(signal);
  if (payload?.family !== "message_activity_event") {
    return { published: 0, unmapped: 1 };
  }

  bus.publish({
    family: payload.family,
    occurredAt: signal.observedAt,
    payload,
    metadata: {
      source: "lifeops-activity-signal",
      signalId: signal.id,
      signalSource: signal.source,
      signalPlatform: signal.platform,
    },
  });
  return { published: 1, unmapped: 0 };
}
