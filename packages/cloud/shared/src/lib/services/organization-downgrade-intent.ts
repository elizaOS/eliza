/** Immutable original lower-plan intent; never shares an upgrade request identity. */
import { z } from "zod";
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
  retainedTermsDigest?: string | null;
}) {
  const { providerBinding, retainedTermsDigest, ...identity } = input;
  if (retainedTermsDigest !== undefined && retainedTermsDigest !== null)
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(retainedTermsDigest);
  return settlementDigest({
    version: retainedTermsDigest ? 2 : 1,
    ...(retainedTermsDigest ? { retainedTermsDigest } : {}),
    kind: "organization_downgrade",
    ...identity,
    providerBinding: organizationPlanChangeProviderBindingSchema.parse(providerBinding),
  });
}
