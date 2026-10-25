/** Exact configured schedule observation. Does not publish state or paid allowance. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  organizationScheduleEffectRequestSchema,
  scheduleEffectRequestDigest,
} from "./organization-schedule-effect-contract";
import {
  recoverOriginalCreatedSchedule,
  recoverOriginalScheduleSnapshot,
} from "./organization-schedule-effect-origin";
import {
  mapRetainedOrganizationSchedulePhases,
  organizationScheduleDefaultsObservationSchema,
  organizationSchedulePhaseObservationSchema,
} from "./organization-schedule-phase-mapping";
import {
  assertOrganizationScheduleQuoteTermsCurrent,
  type OrganizationScheduleQuoteTerms,
} from "./organization-schedule-quote-terms";
import { settlementDigest } from "./settlement-digest";

function reject(): never {
  throw new ElizaError("Configured schedule does not prove the original reviewed change", {
    code: "SUBSCRIPTION_SCHEDULE_CONFIGURATION_UNVERIFIED",
  });
}
function same(a: unknown, b: unknown) {
  if (settlementDigest(a) !== settlementDigest(b)) reject();
}
/** Phase duration follows its start plus the monthly price interval, in UTC.
 * Keep this distinct from the retained subscription billing-cycle anchor.
 */
export function oneMonthlySchedulePhaseEnd(start: number) {
  if (!Number.isSafeInteger(start) || start < 0) reject();
  const d = new Date(start * 1000);
  if (!Number.isFinite(d.getTime())) reject();
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const endOfMonth = new Date(d.getTime());
  endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1);
  endOfMonth.setUTCDate(0);
  d.setUTCDate(Math.min(day, endOfMonth.getUTCDate()));
  const end = d.getTime() / 1000;
  if (!Number.isSafeInteger(end) || end <= start) reject();
  return end;
}
function normalizeDiscounts(value: unknown) {
  if (value === undefined || value === null || value === "") return [];
  const parsed = z
    .array(z.object({ discount: z.string().regex(/^di_[A-Za-z0-9]+$/) }))
    .safeParse(value);
  if (!parsed.success) reject();
  return parsed.data.map((d) => d.discount);
}
function normalizeRates(value: unknown) {
  return value === undefined || value === null || value === "" ? [] : value;
}
export function proveOriginalOrganizationScheduleConfiguration(input: {
  originalCreate: Parameters<typeof recoverOriginalCreatedSchedule>[0];
  originalConfiguration: Parameters<typeof recoverOriginalScheduleSnapshot>[0];
  originalTerms: OrganizationScheduleQuoteTerms;
}) {
  const original = recoverOriginalCreatedSchedule(input.originalCreate),
    configured = recoverOriginalScheduleSnapshot(input.originalConfiguration);
  const parsed = organizationScheduleEffectRequestSchema.safeParse(
    input.originalConfiguration.originalRequest.request,
  );
  if (!parsed.success || parsed.data.kind !== "schedule_configure") reject();
  const request = parsed.data;
  // This is the original authenticated evidence time, not a backdated current observation.
  const receipt = z
    .object({ kind: z.enum(["response", "event"]), observedAt: z.string().datetime() })
    .parse(input.originalConfiguration.originalReceipt);
  const boundary = input.originalTerms.subscription.current_period_end;
  const responseBeforeBoundary =
    receipt.kind === "response" && Date.parse(receipt.observedAt) < boundary * 1000;
  const eventBeforeBoundary =
    input.originalConfiguration.evidence.kind === "event" &&
    z
      .object({ created: z.number().int().nonnegative().safe() })
      .parse(input.originalConfiguration.evidence.raw).created < boundary;
  if (!responseBeforeBoundary && !eventBeforeBoundary) reject();
  if (
    original.id !== configured.id ||
    request.scheduleId !== original.id ||
    configured.end_behavior !== "release"
  )
    reject();
  same(
    [original.customer, original.subscription, original.livemode],
    [configured.customer, configured.subscription, configured.livemode],
  );
  if (
    request.params.phases[0].start_date !== input.originalTerms.subscription.current_period_start ||
    request.params.phases[0].end_date !== input.originalTerms.subscription.current_period_end ||
    request.params.phases[1].start_date !== input.originalTerms.subscription.current_period_end ||
    request.params.phases[0].items[0]!.price !==
      input.originalTerms.subscription.items.data[0]!.price.id
  )
    reject();
  // Reconstruct the permitted request from the original creation snapshot and quote.
  // A durable but structurally valid request must not substitute future retained terms.
  const expectedRequest = mapRetainedOrganizationSchedulePhases({
    schedule: original,
    originalTerms: input.originalTerms,
    mappingAt: input.originalConfiguration.originalRequest.startedAt,
    targetPriceId: request.params.phases[1].items[0]!.price,
  });
  same(request, expectedRequest);
  const defaults = organizationScheduleDefaultsObservationSchema.parse(configured.default_settings);
  same(defaults, organizationScheduleDefaultsObservationSchema.parse(original.default_settings));
  const phases = z
    .array(organizationSchedulePhaseObservationSchema)
    .length(2)
    .parse(configured.phases);
  same(configured.current_phase, {
    start_date: request.params.phases[0].start_date,
    end_date: request.params.phases[0].end_date,
  });
  for (let i = 0; i < 2; i++) {
    const actual = phases[i]!,
      expected = request.params.phases[i]!;
    if (
      actual.start_date !== expected.start_date ||
      actual.end_date !==
        (i === 0 ? expected.end_date : oneMonthlySchedulePhaseEnd(expected.start_date)) ||
      actual.proration_behavior !== "none" ||
      actual.currency !== (expected.currency ?? "usd") ||
      actual.trial_end !== (expected.trial_end ?? null)
    )
      reject();
    same(
      actual.billing_cycle_anchor ?? defaults.billing_cycle_anchor,
      expected.billing_cycle_anchor ?? defaults.billing_cycle_anchor,
    );
    same(
      actual.collection_method ?? defaults.collection_method,
      expected.collection_method ?? defaults.collection_method,
    );
    same(
      actual.default_payment_method ?? defaults.default_payment_method,
      expected.default_payment_method ?? defaults.default_payment_method,
    );
    same(actual.description ?? defaults.description, expected.description ?? defaults.description);
    const tax = expected.automatic_tax;
    same(
      actual.automatic_tax ?? defaults.automatic_tax ?? { enabled: false, liability: null },
      tax
        ? { enabled: tax.enabled, liability: tax.liability ?? null }
        : (defaults.automatic_tax ?? { enabled: false, liability: null }),
    );
    const threshold = expected.billing_thresholds;
    same(
      actual.billing_thresholds ?? defaults.billing_thresholds,
      threshold === ""
        ? null
        : threshold
          ? {
              amount_gte: threshold.amount_gte ?? null,
              reset_billing_cycle_anchor: threshold.reset_billing_cycle_anchor ?? null,
            }
          : defaults.billing_thresholds,
    );
    same(actual.default_tax_rates, normalizeRates(expected.default_tax_rates));
    same(normalizeDiscounts(actual.discounts), normalizeDiscounts(expected.discounts));
    same(actual.metadata ?? {}, expected.metadata ?? {});
    const invoice = actual.invoice_settings ?? defaults.invoice_settings;
    same(
      { issuer: invoice.issuer, account_tax_ids: invoice.account_tax_ids },
      expected.invoice_settings
        ? {
            issuer: expected.invoice_settings.issuer ?? defaults.invoice_settings.issuer,
            account_tax_ids:
              expected.invoice_settings.account_tax_ids === ""
                ? []
                : (expected.invoice_settings.account_tax_ids ??
                  defaults.invoice_settings.account_tax_ids),
          }
        : {
            issuer: defaults.invoice_settings.issuer,
            account_tax_ids: defaults.invoice_settings.account_tax_ids,
          },
    );
    const a = actual.items[0]!,
      e = expected.items[0]!;
    if (a.price !== e.price || a.plan !== e.price || a.quantity !== e.quantity) reject();
    same(a.metadata ?? {}, e.metadata ?? {});
    same(a.tax_rates, normalizeRates(e.tax_rates));
    same(normalizeDiscounts(a.discounts), normalizeDiscounts(e.discounts));
    same(a.billing_thresholds, e.billing_thresholds ? e.billing_thresholds : null);
  }
  return {
    configuredSnapshot: configured,
    scheduleId: configured.id,
    requestDigest: scheduleEffectRequestDigest(request),
    snapshotDigest: settlementDigest(configured),
    effectiveAt: request.params.phases[1].start_date,
  };
}

/** Current-period wrapper. Original evidence remains separate from fresh live terms. */
export function proveOrganizationScheduleConfiguration(
  input: Parameters<typeof proveOriginalOrganizationScheduleConfiguration>[0] & {
    rawCurrentSchedule: unknown;
    rawSubscription: unknown;
    rawCustomer: unknown;
  },
) {
  const { configuredSnapshot: configured, ...proof } =
    proveOriginalOrganizationScheduleConfiguration(input);
  const current = z.record(z.string(), z.unknown()).safeParse(input.rawCurrentSchedule);
  if (!current.success) reject();
  const { lastResponse: _transport, ...currentSnapshot } = current.data;
  same(configured, currentSnapshot);
  const subscription = z.record(z.string(), z.unknown()).safeParse(input.rawSubscription);
  if (
    !subscription.success ||
    subscription.data.schedule !== configured.id ||
    subscription.data.id !== configured.subscription ||
    subscription.data.customer !== configured.customer ||
    subscription.data.livemode !== configured.livemode
  )
    reject();
  assertOrganizationScheduleQuoteTermsCurrent({
    original: input.originalTerms,
    rawSubscription: { ...subscription.data, schedule: null },
    rawCustomer: input.rawCustomer,
    observedAt: input.originalConfiguration.observedAt,
  });
  return proof;
}
