/**
 * Production publisher bridging derived circadian transitions onto the
 * ActivitySignalBus (#12284 WI-4). The legacy scheduler tick
 * (`domains/reminders-service.ts`, circadian_state subsystem) derives
 * wake/sleep/nap/bedtime edge events via plugin-health's
 * `deriveSleepWakeEvents` and dispatches them through `runtime.emitEvent`;
 * this module mirrors those SAME events onto the bus under the matching
 * `health.*` family so the ScheduledTask spine finally sees them:
 * `health_signal_observed` completion checks flip via `hasSignalSince`, and
 * plugin-health's observed-anchor resolvers read the envelopes back through
 * `runtime.activitySignalBus`.
 *
 * Publishing is family-validated by the bus (throws on an unregistered
 * family); the caller's subsystem boundary handles that wiring failure. The
 * `runtime.emitEvent` dispatch stays alongside — event workflows
 * (`runDueEventWorkflows`) and the scheduled-task event bridge consume it.
 */

import {
  healthBusFamilyForDerivedEventKind,
  type LifeOpsDerivedEvent,
} from "@elizaos/plugin-health";
import type { ActivitySignalBus } from "./bus.js";

export interface PublishDerivedHealthSignalsResult {
  /** Envelopes actually published to the bus. */
  published: number;
  /** Events whose kind intentionally carries no bus family (onset candidates). */
  unmapped: number;
}

/**
 * Publishes each mappable derived event as one bus envelope. `occurredAt`
 * carries the transition instant (e.g. the observed wake time), which is
 * exactly what the observed-anchor resolvers return as the anchor instant.
 */
export function publishDerivedHealthSignals(
  bus: ActivitySignalBus,
  events: readonly LifeOpsDerivedEvent[],
): PublishDerivedHealthSignalsResult {
  let published = 0;
  let unmapped = 0;
  for (const event of events) {
    const family = healthBusFamilyForDerivedEventKind(event.kind);
    if (family === null) {
      unmapped += 1;
      continue;
    }
    bus.publish({
      family,
      occurredAt: event.occurredAt,
      payload: event.payload,
      metadata: {
        source: "lifeops-circadian-tick",
        eventKind: event.kind,
        eventId: event.id,
        confidence: event.confidence,
      },
    });
    published += 1;
  }
  return { published, unmapped };
}
