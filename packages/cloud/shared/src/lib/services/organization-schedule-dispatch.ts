/** Private one-time schedule creation. Unknown outcomes retain the original journal effect. */
import { ElizaError } from "@elizaos/core";
import {
  markOrganizationScheduleEffectDispatch,
  readOrganizationScheduleDispatchSource,
  recordAuthenticatedOrganizationScheduleEvidence,
} from "../../db/repositories/organization-schedule-effects";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { repreviewOrganizationDowngrade } from "./organization-downgrade-repreview";
import { assertOrganizationPlanChangeProviderBindingCurrent } from "./organization-plan-change-provider-binding";

export async function dispatchOrganizationScheduleCreate(
  identity: { organizationId: string; actorId: string; commandId: string },
  claim: { commandId: string; leaseToken: string; generation: number },
  effectId: string,
  revalidateSession: () => Promise<void>,
) {
  await revalidateSession();
  const captured = await readOrganizationScheduleDispatchSource(identity, claim, effectId);
  if (captured.effect.request_payload.kind !== "schedule_create")
    throw new ElizaError("Original schedule create effect required", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  await repreviewOrganizationDowngrade(captured);
  await revalidateSession();
  assertOrganizationPlanChangeProviderBindingCurrent(
    captured.providerBinding,
    captured.source,
    captured.review.targetPlanKey,
    getCloudAwareEnv(),
  );
  const stripe = requireStripe();
  // No provider write is allowed before this committed marker. Failure after it
  // remains unknown; never reset or replay a started effect, even with the same key.
  const started = await markOrganizationScheduleEffectDispatch(identity, claim, effectId);
  if (started.request_payload.kind !== "schedule_create")
    throw new ElizaError("Original schedule request changed", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  const raw = await stripe.subscriptionSchedules.create(
    { from_subscription: started.request_payload.subscriptionId },
    {
      apiVersion: captured.providerBinding.apiVersion,
      idempotencyKey: started.provider_idempotency_key,
      maxNetworkRetries: 0,
    },
  );
  const effect = await recordAuthenticatedOrganizationScheduleEvidence(identity, claim, effectId, {
    kind: "response",
    raw,
  });
  // Preserve non-enumerable SDK metadata for subsequent original-snapshot proof.
  // These objects remain private backend state, never a renderer/public response.
  return { effect, evidence: { kind: "response" as const, raw } };
}
