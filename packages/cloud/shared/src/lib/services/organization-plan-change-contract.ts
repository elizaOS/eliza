/** Validated server-owned upgrade review. A quote is neither payment nor mutation authority. */
import type { OrganizationSubscriptionUpgradeReviewDto } from "@elizaos/cloud-sdk/contracts";
import { z } from "zod";

const cents = z.number().int().safe();
const amount = z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/);
const invoice = z
  .object({
    amountDueCents: cents.nonnegative(),
    subtotalCents: cents,
    discountCents: cents.nonnegative(),
    taxCents: cents.nonnegative(),
    totalCents: cents,
    startingBalanceCents: cents,
  })
  .strict();

export const organizationUpgradeReviewSchema: z.ZodType<OrganizationSubscriptionUpgradeReviewDto> =
  z
    .object({
      kind: z.literal("upgrade_estimate"),
      subscriptionId: z.string().uuid(),
      expectedSubscriptionRevision: z.string().regex(/^[1-9]\d*$/),
      sourcePlanKey: z.enum(["plus_monthly", "pro_monthly"]),
      targetPlanKey: z.enum(["plus_monthly", "pro_monthly"]),
      catalogVersion: z.string().min(1),
      currency: z.literal("usd"),
      prorationDate: z.number().int().positive().safe(),
      currentPeriodStart: z.iso.datetime(),
      currentPeriodEnd: z.iso.datetime(),
      targetBaseAmountCents: cents.positive(),
      targetAllowanceUsd: amount,
      additionalAllowanceUsd: amount,
      dueNow: invoice,
      recurringEstimate: invoice,
      observedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const start = Date.parse(value.currentPeriodStart);
      const end = Date.parse(value.currentPeriodEnd);
      const observed = Date.parse(value.observedAt);
      const expiry = Date.parse(value.expiresAt);
      const effective = value.prorationDate * 1000;
      if (
        value.sourcePlanKey === value.targetPlanKey ||
        start >= end ||
        effective < start ||
        effective >= end ||
        effective > observed ||
        observed - effective >= 1000 ||
        expiry <= observed ||
        expiry > end ||
        expiry - observed > 60_000
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Upgrade review has inconsistent source or validity window",
        });
      }
    });
export type OrganizationUpgradeReview = z.infer<typeof organizationUpgradeReviewSchema>;

/** Shared exact amount shape for organization plan review variants. */
export const organizationInvoiceReviewTermsSchema = invoice;
