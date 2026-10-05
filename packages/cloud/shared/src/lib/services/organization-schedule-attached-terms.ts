/** Private continuity check after original schedule attachment and before configuration. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { assertOriginalCreatedScheduleCurrent } from "./organization-schedule-effect-origin";
import {
  assertOrganizationScheduleQuoteTermsCurrent,
  type OrganizationScheduleQuoteTerms,
} from "./organization-schedule-quote-terms";

export function assertOrganizationScheduleAttachedTermsCurrent(
  input: Parameters<typeof assertOriginalCreatedScheduleCurrent>[0] & {
    originalTerms: OrganizationScheduleQuoteTerms;
    rawSubscription: unknown;
    rawCustomer: unknown;
  },
) {
  const schedule = assertOriginalCreatedScheduleCurrent(input);
  const subscription = z.record(z.string(), z.unknown()).safeParse(input.rawSubscription);
  if (
    !subscription.success ||
    subscription.data.schedule !== schedule.id ||
    subscription.data.id !== schedule.subscription ||
    subscription.data.customer !== schedule.customer ||
    subscription.data.livemode !== schedule.livemode
  ) {
    throw new ElizaError("Attached schedule no longer matches the original subscription", {
      code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    });
  }
  // Attachment is the single expected difference. Preserve every other observed field
  // and compare it with the quote's original normalized subscription/customer binding.
  const terms = assertOrganizationScheduleQuoteTermsCurrent({
    original: input.originalTerms,
    rawSubscription: { ...subscription.data, schedule: null },
    rawCustomer: input.rawCustomer,
    observedAt: input.observedAt,
  });
  return { schedule, terms };
}
