/** Immutable original lower-plan intent; never shares an upgrade request identity. */
import {
  type OrganizationPlanChangeProviderBinding,
  organizationPlanChangeProviderBindingSchema,
} from "./organization-plan-change-provider-binding";
import { settlementDigest } from "./settlement-digest";
export function organizationDowngradeIntentDigest(input: {
  organizationId: string;
  actorId: string;
  quoteId: string;
  reviewDigest: string;
  sourceDigest: string;
  providerBinding: OrganizationPlanChangeProviderBinding | null;
}) {
  const { providerBinding, ...identity } = input;
  return settlementDigest({
    version: 1,
    kind: "organization_downgrade",
    ...identity,
    providerBinding: organizationPlanChangeProviderBindingSchema.parse(providerBinding),
  });
}
