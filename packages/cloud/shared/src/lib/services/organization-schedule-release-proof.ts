/** Verify release of the original unconfigured schedule without inventing billing success. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  recoverOriginalCreatedSchedule,
  recoverOriginalScheduleSnapshot,
} from "./organization-schedule-effect-origin";
import {
  assertOrganizationScheduleQuoteTermsCurrent,
  type OrganizationScheduleQuoteTerms,
} from "./organization-schedule-quote-terms";
import { settlementDigest } from "./settlement-digest";

function financialSnapshot(snapshot: Record<string, unknown>) {
  const {
    status: _status,
    subscription: _subscription,
    released_subscription: _released,
    released_at: _at,
    current_phase: _phase,
    ...retained
  } = snapshot;
  return retained;
}
export function proveOrganizationScheduleRelease(input: {
  originalCreate: Parameters<typeof recoverOriginalCreatedSchedule>[0];
  originalRelease: Parameters<typeof recoverOriginalScheduleSnapshot>[0];
  rawCurrentSchedule: unknown;
  rawSubscription: unknown;
  rawCustomer: unknown;
  originalTerms: OrganizationScheduleQuoteTerms;
}) {
  const original = recoverOriginalCreatedSchedule(input.originalCreate),
    released = recoverOriginalScheduleSnapshot(input.originalRelease);
  const reject = () => {
    throw new ElizaError("Original schedule release requires complete unchanged terms", {
      code: "SUBSCRIPTION_SCHEDULE_RELEASE_UNVERIFIED",
    });
  };
  if (
    input.originalRelease.originalRequest.request.kind !== "schedule_release" ||
    released.id !== original.id ||
    released.released_subscription !== original.subscription ||
    released.customer !== original.customer ||
    released.livemode !== original.livemode ||
    settlementDigest(financialSnapshot(released)) !== settlementDigest(financialSnapshot(original))
  )
    reject();
  const parsed = z.record(z.string(), z.unknown()).safeParse(input.rawCurrentSchedule);
  if (!parsed.success) return reject();
  const { lastResponse: _transport, ...snapshot } = parsed.data;
  if (settlementDigest(snapshot) !== settlementDigest(released)) reject();
  const terms = assertOrganizationScheduleQuoteTermsCurrent({
    original: input.originalTerms,
    rawSubscription: input.rawSubscription,
    rawCustomer: input.rawCustomer,
    observedAt: input.originalRelease.observedAt,
  });
  if (
    terms.subscription.id !== original.subscription ||
    terms.subscription.customer !== original.customer ||
    terms.subscription.livemode !== original.livemode
  )
    reject();
  return {
    scheduleId: released.id,
    snapshotDigest: settlementDigest(released),
    retainedTermsDigest: settlementDigest(terms),
  };
}
