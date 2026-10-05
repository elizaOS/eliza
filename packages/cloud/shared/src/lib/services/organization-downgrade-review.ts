/** Pure reviewed terms for a lower plan at the existing period boundary. No schedule, charge or allowance writes. */
import type { OrganizationSubscriptionDowngradeReviewDto } from "@elizaos/cloud-sdk/contracts";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { organizationInvoiceReviewTermsSchema } from "./organization-plan-change-contract";
import { projectOrganizationPlanInvoice } from "./organization-plan-invoice-review";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

export const organizationDowngradeReviewSchema: z.ZodType<OrganizationSubscriptionDowngradeReviewDto> =
  z
    .object({
      kind: z.literal("downgrade_estimate"),
      subscriptionId: z.string().uuid(),
      expectedSubscriptionRevision: z.string().regex(/^[1-9]\d*$/),
      sourcePlanKey: z.enum(["plus_monthly", "pro_monthly"]),
      targetPlanKey: z.enum(["plus_monthly", "pro_monthly"]),
      catalogVersion: z.string().min(1),
      currency: z.literal("usd"),
      currentPeriodStart: z.iso.datetime(),
      currentPeriodEnd: z.iso.datetime(),
      effectiveAt: z.iso.datetime(),
      amountDueNowCents: z.literal(0),
      targetBaseAmountCents: z.number().int().positive().safe(),
      targetAllowanceUsd: z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/),
      recurringEstimate: organizationInvoiceReviewTermsSchema,
      observedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const start = Date.parse(value.currentPeriodStart),
        end = Date.parse(value.currentPeriodEnd);
      const observed = Date.parse(value.observedAt),
        expires = Date.parse(value.expiresAt);
      if (
        value.sourcePlanKey === value.targetPlanKey ||
        start > observed ||
        observed >= end ||
        value.effectiveAt !== value.currentPeriodEnd ||
        expires <= observed ||
        expires > end ||
        expires - observed > 60_000
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Downgrade review has inconsistent source, effective boundary or validity window",
        });
    });
export type OrganizationDowngradeReview = z.infer<typeof organizationDowngradeReviewSchema>;
function reject(reason: string): never {
  throw new ElizaError("Organization downgrade requires a fresh complete provider review", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    context: { reason },
  });
}
export function projectOrganizationDowngradeReview(input: {
  source: BillingSubscription;
  targetPlanKey: "plus_monthly" | "pro_monthly";
  environment: Record<string, string | undefined>;
  observedAt: Date;
  recurring: unknown;
}) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const previous = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const target = resolveSubscriptionPlanDefinition(input.targetPlanKey, source.catalog_version);
  const currentBinding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const targetBinding = resolveSubscriptionProviderBinding(
    input.environment,
    target.key,
    source.catalog_version,
  );
  const start = source.current_period_start?.getTime(),
    end = source.current_period_end?.getTime();
  const observed = input.observedAt.getTime();
  if (
    source.provider !== "stripe" ||
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    start === undefined ||
    end === undefined ||
    !Number.isSafeInteger(observed) ||
    start > observed ||
    observed >= end ||
    target.amountCents >= previous.amountCents ||
    currentBinding.expectedLivemode !== targetBinding.expectedLivemode ||
    targetBinding.expectedLivemode !== (source.provider_environment === "live")
  )
    reject("source_or_lower_target_unavailable");
  const recurringEstimate = projectOrganizationPlanInvoice({
    raw: input.recurring,
    source,
    livemode: targetBinding.expectedLivemode,
    sourcePriceId: currentBinding.priceId,
    targetPriceId: targetBinding.priceId,
    targetAmountCents: target.amountCents,
    prorationDate: Math.floor(observed / 1000),
    periodEndMs: end,
    kind: "recurring",
  });
  return organizationDowngradeReviewSchema.parse({
    kind: "downgrade_estimate",
    subscriptionId: source.id,
    expectedSubscriptionRevision: String(source.lifecycle_revision),
    sourcePlanKey: source.plan_key,
    targetPlanKey: target.key,
    catalogVersion: source.catalog_version,
    currency: "usd",
    currentPeriodStart: new Date(start).toISOString(),
    currentPeriodEnd: new Date(end).toISOString(),
    effectiveAt: new Date(end).toISOString(),
    amountDueNowCents: 0,
    targetBaseAmountCents: target.amountCents,
    targetAllowanceUsd: target.allowance.amountUsd,
    recurringEstimate,
    observedAt: input.observedAt.toISOString(),
    expiresAt: new Date(Math.min(observed + 60_000, end)).toISOString(),
  });
}
