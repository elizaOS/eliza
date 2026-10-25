/** Pinned Acacia request identities for sequential organization schedule effects. No provider I/O. */

import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
import { settlementDigest } from "./settlement-digest";

const seconds = z.number().int().nonnegative().safe();
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const metadata = z.record(z.string(), z.string());
const discount = z.union([
  z.object({ discount: id("di") }).strict(),
  z.object({ coupon: z.string().min(1) }).strict(),
  z.object({ promotion_code: id("promo") }).strict(),
]);
const discounts = z.union([z.array(discount), z.literal("")]);
const taxRates = z.union([z.array(id("txr")), z.literal("")]);
const automaticTax = z
  .object({
    enabled: z.boolean(),
    liability: z
      .object({ type: z.literal("self") })
      .strict()
      .optional(),
  })
  .strict();
const thresholds = z
  .object({
    amount_gte: z.number().int().positive().safe().optional(),
    reset_billing_cycle_anchor: z.boolean().optional(),
  })
  .strict();
const phase = z
  .object({
    start_date: seconds,
    end_date: seconds.optional(),
    iterations: z.literal(1).optional(),
    items: z
      .array(
        z
          .object({
            price: id("price"),
            quantity: z.literal(1),
            discounts: discounts.optional(),
            tax_rates: taxRates.optional(),
            metadata: metadata.optional(),
            billing_thresholds: z
              .union([
                z.object({ usage_gte: z.number().int().positive().safe() }).strict(),
                z.literal(""),
              ])
              .optional(),
          })
          .strict(),
      )
      .length(1),
    proration_behavior: z.literal("none"),
    currency: z.literal("usd").optional(),
    collection_method: z.literal("charge_automatically").optional(),
    automatic_tax: automaticTax.optional(),
    billing_cycle_anchor: z.enum(["automatic", "phase_start"]).optional(),
    billing_thresholds: z.union([thresholds, z.literal("")]).optional(),
    default_payment_method: id("pm").optional(),
    default_tax_rates: taxRates.optional(),
    discounts: discounts.optional(),
    coupon: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: metadata.optional(),
    invoice_settings: z
      .object({
        account_tax_ids: z.union([z.array(id("txi")), z.literal("")]).optional(),
        issuer: z
          .object({ type: z.literal("self") })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    trial_end: seconds.optional(),
  })
  .strict()
  .superRefine((p, c) => {
    if (
      (p.end_date === undefined) === (p.iterations === undefined) ||
      (p.end_date !== undefined && p.end_date <= p.start_date) ||
      (p.coupon !== undefined && p.discounts !== undefined)
    )
      c.addIssue({
        code: "custom",
        message: "Phase must have one duration and one discount representation",
      });
  });
export const organizationScheduleEffectRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("schedule_release"),
      scheduleId: id("sub_sched"),
      params: z.object({ preserve_cancel_date: z.literal(true) }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal("schedule_create"), subscriptionId: id("sub") }).strict(),
  z
    .object({
      kind: z.literal("schedule_configure"),
      scheduleId: id("sub_sched"),
      params: z
        .object({
          end_behavior: z.literal("release"),
          proration_behavior: z.literal("none"),
          phases: z.tuple([phase, phase]),
        })
        .strict(),
    })
    .strict(),
]);
export type OrganizationScheduleEffectRequest = z.infer<
  typeof organizationScheduleEffectRequestSchema
>;
export const organizationScheduleEffectReceiptSchema = z
  .object({
    kind: z.enum(["response", "event"]),
    scheduleId: id("sub_sched"),
    customerId: id("cus"),
    subscriptionId: id("sub"),
    livemode: z.boolean(),
    apiVersion: z.literal(GENERIC_BILLING_STRIPE_API_VERSION),
    providerRequestId: id("req"),
    providerIdempotencyKey: z.string().min(1),
    eventId: id("evt").nullable(),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .refine((r) => (r.kind === "event") === (r.eventId !== null), {
    message: "Receipt must retain its evidence kind",
  });
export type OrganizationScheduleEffectReceipt = z.infer<
  typeof organizationScheduleEffectReceiptSchema
>;
export function scheduleEffectRequestDigest(request: OrganizationScheduleEffectRequest) {
  return settlementDigest(organizationScheduleEffectRequestSchema.parse(request));
}
export function assertScheduleRequestScope(input: {
  request: OrganizationScheduleEffectRequest;
  subscriptionId: string;
  sourcePriceId: string;
  targetPriceId: string;
  periodStart: Date;
  periodEnd: Date;
  predecessorScheduleId: string | null;
}) {
  const r = organizationScheduleEffectRequestSchema.parse(input.request);
  const reject = () => {
    throw new ElizaError("Schedule request no longer matches the original review", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  };
  if (r.kind === "schedule_create") {
    if (r.subscriptionId !== input.subscriptionId || input.predecessorScheduleId !== null) reject();
    return r;
  }
  if (r.kind === "schedule_release") {
    if (r.scheduleId !== input.predecessorScheduleId) reject();
    return r;
  }
  const [current, target] = r.params.phases;
  if (
    r.scheduleId !== input.predecessorScheduleId ||
    current.start_date * 1000 !== input.periodStart.getTime() ||
    current.end_date !== input.periodEnd.getTime() / 1000 ||
    current.iterations !== undefined ||
    target.start_date * 1000 !== input.periodEnd.getTime() ||
    target.iterations !== 1 ||
    target.end_date !== undefined ||
    current.items[0]!.price !== input.sourcePriceId ||
    target.items[0]!.price !== input.targetPriceId ||
    target.trial_end !== undefined
  )
    reject();
  return r;
}
