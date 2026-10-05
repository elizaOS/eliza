/** Read-only recovery of original schedule effects; no missing outcome can authorize another POST. */
import { ElizaError } from "@elizaos/core";
import {
  projectAuthenticatedScheduleEvent,
  scheduleEffectEventType,
} from "./organization-schedule-effect-origin";
import {
  findUniqueOriginalStripeEvent,
  type OriginalStripeEventReader,
} from "./stripe-original-event-search";
export async function findOriginalScheduleEvent(input: {
  reader: OriginalStripeEventReader<
    | "subscription_schedule.created"
    | "subscription_schedule.updated"
    | "subscription_schedule.released"
  >;
  originalRequest: Parameters<typeof projectAuthenticatedScheduleEvent>[0]["originalRequest"];
  observedAt: Date;
}) {
  return findUniqueOriginalStripeEvent({
    reader: input.reader,
    eventType: scheduleEffectEventType(input.originalRequest.request),
    startedAt: input.originalRequest.startedAt,
    observedAt: input.observedAt,
    providerIdempotencyKey: input.originalRequest.providerIdempotencyKey,
    project: (raw) => {
      const receipt = projectAuthenticatedScheduleEvent({ ...input, raw });
      return { value: receipt, identity: receipt.evidenceDigest };
    },
    unavailable: (reason) => {
      throw new ElizaError(
        "Original schedule recovery requires complete authenticated attribution",
        {
          code: "SUBSCRIPTION_SCHEDULE_RECOVERY_UNAVAILABLE",
          context: { reason },
        },
      );
    },
  });
}
