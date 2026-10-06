/** One retained-current-phase update for schedule cancellation/resumption. Never payment authority. */
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import type { OrganizationScheduleEffectRequest } from "./organization-schedule-effect-contract";
import type { OrganizationScheduleQuoteTerms } from "./organization-schedule-quote-terms";
import { organizationScheduleRetainedSubscriptionSchema } from "./organization-schedule-retained-terms";
import { settlementDigest } from "./settlement-digest";
import { cancellationReobserve } from "./stripe-period-end-cancellation";

export interface ConfiguredCancellationAuthority {
  scheduleId: string;
  originalSnapshot: Record<string, unknown>;
  originalTerms: OrganizationScheduleQuoteTerms;
  originalRequest: Extract<OrganizationScheduleEffectRequest, { kind: "schedule_configure" }>;
  originalPending: boolean;
  authorityDigest: string;
}
export function configuredCancellationRequest(
  authority: ConfiguredCancellationAuthority,
  cancel: boolean,
) {
  const phase = authority.originalRequest.params.phases[0];
  return {
    end_behavior: cancel ? ("cancel" as const) : ("release" as const),
    proration_behavior: "none" as const,
    phases: [structuredClone(phase)],
  };
}
/** Compare complete schedule state and supported subscription financial terms. Lifecycle fields
 * are normalized only after verifying their actual schedule-bound cancellation semantics. */
export function observeConfiguredCancellation(input: {
  authority: ConfiguredCancellationAuthority;
  source: BillingSubscription;
  rawSchedule: unknown;
  rawSubscription: unknown;
  observedAt: Date;
}) {
  const { authority, source } = input;
  const fail = () => cancellationReobserve("configured_cancellation_terms_changed");
  const original = authority.originalTerms.subscription;
  const sourceStart = source.current_period_start?.getTime(),
    sourceEnd = source.current_period_end?.getTime();
  if (
    !Number.isSafeInteger(input.observedAt.getTime()) ||
    sourceStart !== original.current_period_start * 1000 ||
    sourceEnd !== original.current_period_end * 1000 ||
    input.observedAt.getTime() < sourceStart ||
    input.observedAt.getTime() >= sourceEnd ||
    source.stripe_subscription_id !== original.id ||
    source.stripe_customer_id !== original.customer ||
    source.stripe_subscription_item_id !== original.items.data[0]!.id ||
    source.status !== "active" ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null
  )
    fail();
  const schedule = z.record(z.string(), z.unknown()).parse(input.rawSchedule);
  const { lastResponse: _transport, ...wire } = schedule;
  const phases = z.array(z.unknown()).length(2).parse(authority.originalSnapshot.phases);
  const initial = settlementDigest(wire) === settlementDigest(authority.originalSnapshot);
  const cancelled = { ...authority.originalSnapshot, phases: [phases[0]], end_behavior: "cancel" };
  const resumed = { ...authority.originalSnapshot, phases: [phases[0]], end_behavior: "release" };
  const mode = initial
    ? "pending"
    : settlementDigest(wire) === settlementDigest(cancelled)
      ? "cancelled"
      : settlementDigest(wire) === settlementDigest(resumed)
        ? "resumed"
        : fail();
  const raw = z.record(z.string(), z.unknown()).parse(input.rawSubscription);
  const life = z
    .object({
      schedule: z.literal(authority.scheduleId),
      cancel_at_period_end: z.boolean(),
      cancel_at: z.number().int().nonnegative().safe().nullable(),
      canceled_at: z.number().int().nonnegative().safe().nullable(),
    })
    .parse(raw);
  if (
    mode === "cancelled"
      ? life.cancel_at !== original.current_period_end
      : life.cancel_at !== null || life.cancel_at_period_end
  )
    fail();
  if (
    life.canceled_at !== null &&
    (life.canceled_at > input.observedAt.getTime() / 1000 ||
      life.canceled_at > original.current_period_end)
  )
    fail();
  const normalized = organizationScheduleRetainedSubscriptionSchema.parse({
    ...raw,
    schedule: null,
    cancel_at_period_end: original.cancel_at_period_end,
    cancel_at: original.cancel_at,
    canceled_at: original.canceled_at,
  });
  if (settlementDigest(normalized) !== settlementDigest(original)) fail();
  if (mode === "pending" && !authority.originalPending) fail();
  return {
    mode,
    scheduled: mode === "cancelled",
    canceledAt: life.canceled_at === null ? null : new Date(life.canceled_at * 1000),
    providerObjectDigest: settlementDigest({
      schedule: wire,
      subscription: normalized,
      cancelAt: life.cancel_at,
      canceledAt: life.canceled_at,
      authority: authority.authorityDigest,
    }),
  };
}
