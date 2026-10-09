import { proveReviewedOrganizationScheduleConfiguration } from "./organization-schedule-reviewed-configuration";
import { proveOriginalConfiguredTarget as prove } from "./organization-schedule-target-authority";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { settlementDigest } from "./settlement-digest";
export function originalTargetFixture(): Parameters<typeof prove>[0] {
  const f = reviewFixture(),
    proof = {
      kind: "original_schedule_configured" as const,
      ...proveReviewedOrganizationScheduleConfiguration(f),
      quoteId: "original_quote",
      sourceDigest: "a".repeat(64),
      createEffectId: "original_create",
      configurationEffectId: "original_configure",
      createReceiptDigest: "b".repeat(64),
      configurationReceiptDigest: "c".repeat(64),
      observedAt: new Date(150000).toISOString(),
    };
  const digest = settlementDigest(proof),
    target = f.rawCurrentSchedule.phases[1]!;
  return {
    source: {
      ...f.source,
      organization_id: "org_original",
      lifecycle_revision: 2,
      pending_plan_key: "plus_monthly",
      provider_object_digest: digest,
    },
    command: {
      id: "command_original",
      organization_id: "org_original",
      subscription_id: f.source.id,
      app_id: null,
      billing_scope_id: null,
      merchant_key: "platform",
      kind: "downgrade",
      status: "APPLIED",
      target_plan_key: "plus_monthly",
      expected_subscription_revision: 1,
      result_subscription_id: f.source.id,
      result_subscription_revision: 2,
      provider_response_digest: digest,
      organization_schedule_configuration_evidence: proof,
      organization_schedule_configuration_snapshot: structuredClone(f.rawCurrentSchedule),
    },
    quoteId: proof.quoteId,
    review: f.review,
    providerBinding: f.providerBinding,
    rawCurrentSchedule: {
      ...structuredClone(f.rawCurrentSchedule),
      current_phase: { start_date: target.start_date, end_date: target.end_date },
    },
    observedAt: new Date(30 * 86400 * 1000 + 150000),
  };
}
