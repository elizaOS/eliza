/** Non-secret catalog identities captured with a reviewed organization upgrade. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { settlementDigest } from "./settlement-digest";
import { resolveSubscriptionProviderBinding } from "./subscription-catalog";
export const organizationUpgradeProviderBindingSchema = z
  .object({
    sourcePriceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
    targetPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
    sourceProductId: z.string().regex(/^prod_[A-Za-z0-9]+$/),
    targetProductId: z.string().regex(/^prod_[A-Za-z0-9]+$/),
    livemode: z.boolean(),
    apiVersion: z.literal(GENERIC_BILLING_STRIPE_API_VERSION),
  })
  .strict()
  .refine((x) => x.sourcePriceId !== x.targetPriceId && x.sourceProductId !== x.targetProductId, {
    message: "Upgrade requires distinct source and target catalog identities",
  });
export type OrganizationUpgradeProviderBinding = z.infer<
  typeof organizationUpgradeProviderBindingSchema
>;
export function resolveOrganizationUpgradeProviderBinding(
  source: BillingSubscription,
  targetPlanKey: "plus_monthly" | "pro_monthly",
  environment: Record<string, string | undefined>,
): OrganizationUpgradeProviderBinding {
  assertOrganizationSubscription(source);
  const previous = resolveSubscriptionProviderBinding(
    environment,
    source.plan_key,
    source.catalog_version,
  );
  const target = resolveSubscriptionProviderBinding(
    environment,
    targetPlanKey,
    source.catalog_version,
  );
  if (
    previous.expectedLivemode !== target.expectedLivemode ||
    target.expectedLivemode !== (source.provider_environment === "live")
  )
    throw new ElizaError("Organization upgrade provider mode changed", {
      code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    });
  return organizationUpgradeProviderBindingSchema.parse({
    sourcePriceId: previous.priceId,
    targetPriceId: target.priceId,
    sourceProductId: previous.productId,
    targetProductId: target.productId,
    livemode: target.expectedLivemode,
    apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
  });
}
export function assertOrganizationUpgradeProviderBindingCurrent(
  binding: OrganizationUpgradeProviderBinding,
  source: BillingSubscription,
  targetPlanKey: "plus_monthly" | "pro_monthly",
  environment: Record<string, string | undefined>,
) {
  if (
    settlementDigest(organizationUpgradeProviderBindingSchema.parse(binding)) !==
    settlementDigest(resolveOrganizationUpgradeProviderBinding(source, targetPlanKey, environment))
  )
    throw new ElizaError("Organization upgrade catalog binding changed; review again", {
      code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    });
}
/** Version one is retained only to identify pre-binding commands; it cannot grant new dispatch. */
export function organizationUpgradeIntentDigest(input: {
  organizationId: string;
  actorId: string;
  quoteId: string;
  reviewDigest: string;
  sourceDigest: string;
  providerBinding: OrganizationUpgradeProviderBinding | null;
}) {
  const { providerBinding, ...identity } = input;
  return settlementDigest({
    version: providerBinding === null ? 1 : 2,
    kind: "organization_upgrade",
    ...identity,
    ...(providerBinding === null
      ? {}
      : { providerBinding: organizationUpgradeProviderBindingSchema.parse(providerBinding) }),
  });
}
