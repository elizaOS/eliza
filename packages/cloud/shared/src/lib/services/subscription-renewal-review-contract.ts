/** Persisted server-observed renewal estimate. Its digest compares terms; it grants no authority. */

import type { OrganizationSubscriptionRenewalReviewDto } from "@elizaos/cloud-sdk/contracts";
import { z } from "zod";

const cents = z.number().int().safe();
export const subscriptionRenewalReviewSchema: z.ZodType<OrganizationSubscriptionRenewalReviewDto> =
  z
    .object({
      kind: z.literal("renewal_estimate"),
      subscriptionId: z.string().uuid(),
      expectedSubscriptionRevision: z.string().regex(/^[1-9]\d*$/),
      planKey: z.enum(["plus_monthly", "pro_monthly"]),
      catalogVersion: z.string().min(1),
      currency: z.literal("usd"),
      interval: z.literal("month"),
      intervalCount: z.literal(1),
      baseAmountCents: cents.positive(),
      renewalAt: z.iso.datetime(),
      nextPeriodEnd: z.iso.datetime(),
      subtotalCents: cents.nonnegative(),
      discountCents: cents.nonnegative(),
      taxCents: cents.nonnegative(),
      totalCents: cents.nonnegative(),
      startingBalanceCents: cents,
      amountDueCents: cents.nonnegative(),
      observedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      termsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
export type SubscriptionRenewalReview = OrganizationSubscriptionRenewalReviewDto;
