/** Pure Acacia mapping. Caller authenticates observations and owns the original command lease. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { assertOrganizationScheduleAttachedTermsCurrent } from "./organization-schedule-attached-terms";
import { organizationScheduleEffectRequestSchema } from "./organization-schedule-effect-contract";
import {
  type OrganizationScheduleQuoteTerms,
  organizationScheduleQuoteTermsSchema,
} from "./organization-schedule-quote-terms";
import { settlementDigest } from "./settlement-digest";

const ref = (prefix: string) =>
  z.union([
    z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`)),
    z
      .object({
        id: z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`)),
        deleted: z.literal(false).optional(),
      })
      .transform((v) => v.id),
  ]);
const metadata = z.record(z.string(), z.string()).nullable();
const self = z.object({ type: z.literal("self") }).strict();
const autoTax = z.object({ enabled: z.boolean(), liability: self.nullable() }).strict();
const thresholds = z
  .object({
    amount_gte: z.number().int().positive().nullable(),
    reset_billing_cycle_anchor: z.boolean().nullable(),
  })
  .strict()
  .nullable();
const invoice = z
  .object({
    account_tax_ids: z.array(ref("txi")).nullable(),
    days_until_due: z.null(),
    issuer: self,
  })
  .strict();
const discounts = z
  .array(
    z
      .object({
        coupon: z.unknown().nullable(),
        discount: ref("di").nullable(),
        promotion_code: z.unknown().nullable(),
      })
      .strict(),
  )
  .nullable();
const rates = z
  .array(ref("txr"))
  .nullable()
  .optional()
  .transform((v) => v ?? []);
export const organizationScheduleDefaultsObservationSchema = z
  .object({
    application_fee_percent: z.null(),
    automatic_tax: autoTax.optional(),
    billing_cycle_anchor: z.enum(["automatic", "phase_start"]),
    billing_thresholds: thresholds,
    collection_method: z.literal("charge_automatically").nullable(),
    default_payment_method: ref("pm").nullable(),
    description: z.string().nullable(),
    invoice_settings: invoice,
    on_behalf_of: z.null(),
    transfer_data: z.null(),
  })
  .strict();
export const organizationSchedulePhaseObservationSchema = z
  .object({
    add_invoice_items: z.array(z.never()).length(0),
    application_fee_percent: z.null(),
    automatic_tax: autoTax.optional(),
    billing_cycle_anchor: z.enum(["automatic", "phase_start"]).nullable(),
    billing_thresholds: thresholds,
    collection_method: z.literal("charge_automatically").nullable(),
    coupon: z.null(),
    currency: z.literal("usd"),
    default_payment_method: ref("pm").nullable(),
    default_tax_rates: rates,
    description: z.string().nullable(),
    discounts,
    end_date: z.number().int().nonnegative(),
    invoice_settings: invoice.nullable(),
    items: z
      .array(
        z
          .object({
            billing_thresholds: z
              .object({ usage_gte: z.number().int().positive().nullable() })
              .strict()
              .nullable(),
            discounts,
            metadata,
            plan: ref("price"),
            price: ref("price"),
            quantity: z.literal(1),
            tax_rates: rates,
          })
          .strict(),
      )
      .length(1),
    metadata,
    on_behalf_of: z.null(),
    proration_behavior: z.enum(["always_invoice", "create_prorations", "none"]),
    start_date: z.number().int().nonnegative(),
    transfer_data: z.null(),
    trial_end: z.number().int().nonnegative().nullable(),
  })
  .strict();
function reject(): never {
  throw new ElizaError("Created schedule cannot preserve the reviewed billing terms", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
  });
}
function same(a: unknown, b: unknown) {
  if (settlementDigest(a) !== settlementDigest(b)) reject();
}
function existingDiscounts(value: z.infer<typeof discounts>) {
  // Reuse actual discount identities; never recreate coupon durations from descriptors.
  return (value ?? []).map((d) => {
    if (d.discount === null) reject();
    return d.discount;
  });
}
function thresholdParams(t: Exclude<z.infer<typeof thresholds>, null>) {
  return {
    ...(t.amount_gte === null ? {} : { amount_gte: t.amount_gte }),
    ...(t.reset_billing_cycle_anchor === null
      ? {}
      : { reset_billing_cycle_anchor: t.reset_billing_cycle_anchor }),
  };
}
export function mapOrganizationDowngradeSchedulePhases(
  input: Parameters<typeof assertOrganizationScheduleAttachedTermsCurrent>[0] & {
    targetPriceId: string;
  },
) {
  const { schedule, terms } = assertOrganizationScheduleAttachedTermsCurrent(input);
  return mapRetainedOrganizationSchedulePhases({
    schedule,
    originalTerms: terms,
    mappingAt: input.observedAt,
    targetPriceId: input.targetPriceId,
  });
}
/** Deterministic request reconstruction from authenticated original creation and retained
 * quote terms. This does not observe current provider state or authorize a write. */
export function mapRetainedOrganizationSchedulePhases(input: {
  schedule: ReturnType<typeof assertOrganizationScheduleAttachedTermsCurrent>["schedule"];
  originalTerms: OrganizationScheduleQuoteTerms;
  mappingAt: Date;
  targetPriceId: string;
}) {
  const { schedule } = input,
    terms = organizationScheduleQuoteTermsSchema.parse(input.originalTerms);
  const at = input.mappingAt.getTime(),
    original = terms.subscription;
  if (
    !Number.isFinite(at) ||
    at < original.current_period_start * 1000 ||
    at >= original.current_period_end * 1000 ||
    schedule.subscription !== original.id ||
    schedule.customer !== original.customer ||
    schedule.livemode !== original.livemode ||
    terms.customer.customerId !== original.customer ||
    terms.customer.livemode !== original.livemode
  )
    reject();
  const parsedDefaults = organizationScheduleDefaultsObservationSchema.safeParse(
    schedule.default_settings,
  );
  const parsedPhases = z
    .array(organizationSchedulePhaseObservationSchema)
    .length(1)
    .safeParse(schedule.phases);
  if (!parsedDefaults.success || !parsedPhases.success) reject();
  const d = parsedDefaults.data,
    p = parsedPhases.data[0]!,
    s = terms.subscription,
    item = s.items.data[0]!,
    pi = p.items[0]!;
  if (
    schedule.end_behavior !== "release" ||
    p.start_date !== s.current_period_start ||
    p.end_date !== s.current_period_end ||
    schedule.current_phase.start_date !== p.start_date ||
    schedule.current_phase.end_date !== p.end_date ||
    pi.price !== item.price.id ||
    pi.plan !== pi.price ||
    input.targetPriceId === pi.price
  )
    reject();
  same(p.automatic_tax ?? d.automatic_tax ?? { enabled: false, liability: null }, s.automatic_tax);
  same(p.billing_thresholds ?? d.billing_thresholds, s.billing_thresholds);
  same(p.collection_method ?? d.collection_method ?? "charge_automatically", s.collection_method);
  same(p.default_payment_method ?? d.default_payment_method, s.default_payment_method);
  same(p.default_tax_rates, s.default_tax_rates);
  same(p.description ?? d.description, s.description);
  const inv = p.invoice_settings ?? d.invoice_settings;
  same({ account_tax_ids: inv.account_tax_ids, issuer: inv.issuer }, s.invoice_settings);
  same(existingDiscounts(p.discounts), s.discounts);
  same(existingDiscounts(pi.discounts), item.discounts);
  same(pi.tax_rates, item.tax_rates);
  same(pi.billing_thresholds, item.billing_thresholds);
  // Phase metadata is an update, not the full current subscription metadata. Carry
  // the reviewed resulting metadata forward instead of replaying historical removals.
  for (const [key, value] of Object.entries(p.metadata ?? {})) {
    if (value === "" ? key in s.metadata : s.metadata[key] !== value) reject();
  }
  for (const [key, value] of Object.entries(pi.metadata ?? {})) {
    if (value === "" ? key in item.metadata : item.metadata[key] !== value) reject();
  }
  if (
    p.trial_end !== null &&
    (p.trial_end !== s.trial_end || p.trial_end > input.mappingAt.getTime() / 1000)
  )
    reject();
  const anchor = p.billing_cycle_anchor ?? d.billing_cycle_anchor;
  if (anchor === "phase_start" && s.billing_cycle_anchor !== p.start_date) reject();
  const phaseTerms = {
    currency: "usd" as const,
    proration_behavior: "none" as const,
    ...(p.collection_method === null ? {} : { collection_method: p.collection_method }),
    ...(p.automatic_tax === undefined
      ? {}
      : {
          automatic_tax: {
            enabled: p.automatic_tax.enabled,
            ...(p.automatic_tax.liability === null ? {} : { liability: p.automatic_tax.liability }),
          },
        }),
    ...(p.billing_cycle_anchor === null ? {} : { billing_cycle_anchor: p.billing_cycle_anchor }),
    ...(p.billing_thresholds === null
      ? {}
      : { billing_thresholds: thresholdParams(p.billing_thresholds) }),
    ...(p.default_payment_method === null
      ? {}
      : { default_payment_method: p.default_payment_method }),
    ...(p.description === null ? {} : { description: p.description }),
    default_tax_rates: p.default_tax_rates,
    // Omission retains customer inheritance. Empty string would suppress it.
    ...(s.discounts.length === 0
      ? {}
      : { discounts: s.discounts.map((discount) => ({ discount })) }),
    ...(p.invoice_settings === null
      ? {}
      : {
          invoice_settings: {
            issuer: inv.issuer,
            ...(inv.account_tax_ids === null ? {} : { account_tax_ids: inv.account_tax_ids }),
          },
        }),
    metadata: s.metadata,
  };
  const itemTerms = {
    quantity: 1 as const,
    metadata: item.metadata,
    tax_rates: item.tax_rates,
    ...(item.discounts.length === 0
      ? {}
      : { discounts: item.discounts.map((discount) => ({ discount })) }),
    ...(item.billing_thresholds?.usage_gte == null
      ? {}
      : { billing_thresholds: { usage_gte: item.billing_thresholds.usage_gte } }),
  };
  return organizationScheduleEffectRequestSchema.parse({
    kind: "schedule_configure",
    scheduleId: schedule.id,
    params: {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          ...phaseTerms,
          start_date: p.start_date,
          end_date: p.end_date,
          items: [{ ...itemTerms, price: pi.price }],
          ...(p.trial_end === null ? {} : { trial_end: p.trial_end }),
        },
        {
          ...phaseTerms,
          start_date: p.end_date,
          iterations: 1,
          items: [{ ...itemTerms, price: input.targetPriceId }],
        },
      ],
    },
  });
}
