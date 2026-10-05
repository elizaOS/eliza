/** Compatibility names retain original upgrade digest and import behavior. Shared binding has no direction-specific authority. */
import {
  type OrganizationPlanChangeProviderBinding as OrganizationUpgradeProviderBinding,
  organizationPlanChangeProviderBindingSchema as organizationUpgradeProviderBindingSchema,
} from "./organization-plan-change-provider-binding";
import { settlementDigest } from "./settlement-digest";

export {
  assertOrganizationPlanChangeProviderBindingCurrent as assertOrganizationUpgradeProviderBindingCurrent,
  type OrganizationPlanChangeProviderBinding as OrganizationUpgradeProviderBinding,
  organizationPlanChangeProviderBindingSchema as organizationUpgradeProviderBindingSchema,
  resolveOrganizationPlanChangeProviderBinding as resolveOrganizationUpgradeProviderBinding,
} from "./organization-plan-change-provider-binding";
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
