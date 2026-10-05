/** Internal phase preparation and one-shot update followed by original-state publication. */

import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import {
  markOrganizationScheduleEffectDispatch,
  prepareOrganizationScheduleConfiguration,
  readOrganizationScheduleConfigurationSource,
  readOrganizationScheduleDispatchSource,
  recordAuthenticatedOrganizationScheduleEvidence,
} from "../../db/repositories/organization-schedule-effects";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { projectOrganizationDowngradeReview } from "./organization-downgrade-review";
import { assertOrganizationPlanChangeProviderBindingCurrent } from "./organization-plan-change-provider-binding";
import { scheduleEffectRequestDigest } from "./organization-schedule-effect-contract";
import { findOriginalScheduleEvent } from "./organization-schedule-event-search";
import { mapOrganizationDowngradeSchedulePhases } from "./organization-schedule-phase-mapping";
import { observeAndFinalizeOrganizationScheduleConfiguration } from "./organization-schedule-publication";
import { settlementDigest } from "./settlement-digest";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
} from "./subscription-catalog";

type Identity = { organizationId: string; actorId: string; commandId: string };
type Claim = { commandId: string; leaseToken: string; generation: number };
type Evidence = { kind: "response" | "event"; raw: unknown };
function reject(): never {
  throw new ElizaError("Original schedule configuration requires current complete terms", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
  });
}
async function observeConfiguration(
  captured: Awaited<ReturnType<typeof readOrganizationScheduleDispatchSource>>,
  evidence?: Evidence,
) {
  const create =
    captured.effect.kind === "schedule_create" ? captured.effect : captured.predecessor;
  if (
    !create ||
    create.kind !== "schedule_create" ||
    create.state !== "observed" ||
    !create.receipt ||
    !create.started_at
  )
    reject();
  const { source, review, providerBinding } = captured,
    environment = { ...getCloudAwareEnv() };
  const current = () => {
    if (Date.now() >= Date.parse(review.expiresAt)) reject();
    assertOrganizationPlanChangeProviderBindingCurrent(
      providerBinding,
      source,
      review.targetPlanKey,
      getCloudAwareEnv(),
    );
  };
  current();
  const stripe = requireStripe(),
    options = { apiVersion: providerBinding.apiVersion };
  await getVerifiedSubscriptionPlans({
    env: environment,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  const originalRequest = {
    request: create.request_payload,
    providerIdempotencyKey: create.provider_idempotency_key,
    customerId: create.customer_id,
    subscriptionId: create.subscription_id,
    livemode: create.livemode,
    startedAt: create.started_at,
  };
  const originalEvidence = evidence ?? {
    kind: "event" as const,
    raw: (
      await findOriginalScheduleEvent({
        reader: stripe.events,
        originalRequest,
        observedAt: new Date(),
      })
    ).raw,
  };
  const rawCustomer = await stripe.customers.retrieve(
    source.stripe_customer_id,
    { expand: ["tax_ids"] },
    options,
  );
  const rawSubscription = await stripe.subscriptions.retrieve(
    source.stripe_subscription_id,
    {},
    options,
  );
  const rawCurrentSchedule = await stripe.subscriptionSchedules.retrieve(
    create.receipt.scheduleId,
    {},
    options,
  );
  const request = mapOrganizationDowngradeSchedulePhases({
    originalReceipt: create.receipt,
    originalRequest,
    evidence: originalEvidence,
    rawCurrentSchedule,
    originalTerms: captured.retainedTerms,
    rawCustomer,
    rawSubscription,
    observedAt: new Date(),
    targetPriceId: providerBinding.targetPriceId,
  });
  if (request.kind !== "schedule_configure") reject();
  // Preview the actual mapped schedule, including preserved phase/default inheritance.
  // A subscription item-only preview would not validate this schedule update's terms.
  const recurring = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      schedule: request.scheduleId,
      preview_mode: "recurring",
      schedule_details:
        request.params as unknown as Stripe.InvoiceCreatePreviewParams.ScheduleDetails,
    },
    options,
  );
  const repeated = projectOrganizationDowngradeReview({
    source,
    targetPlanKey: review.targetPlanKey,
    environment,
    observedAt: new Date(review.observedAt),
    recurring,
  });
  if (settlementDigest(repeated) !== settlementDigest(review)) reject();
  current();
  return { request, createEvidence: originalEvidence };
}
export async function prepareObservedOrganizationScheduleConfiguration(
  identity: Identity,
  claim: Claim,
  createEffectId: string,
  revalidateSession: () => Promise<void>,
  evidence?: Evidence,
) {
  await revalidateSession();
  const captured = await readOrganizationScheduleConfigurationSource(
    identity,
    claim,
    createEffectId,
  );
  const { request } = await observeConfiguration(captured, evidence);
  await revalidateSession();
  assertOrganizationPlanChangeProviderBindingCurrent(
    captured.providerBinding,
    captured.source,
    captured.review.targetPlanKey,
    getCloudAwareEnv(),
  );
  return prepareOrganizationScheduleConfiguration(identity, claim, request);
}
export async function dispatchOrganizationScheduleConfiguration(
  identity: Identity,
  claim: Claim,
  effectId: string,
  revalidateSession: () => Promise<void>,
  evidence?: Evidence,
) {
  await revalidateSession();
  const captured = await readOrganizationScheduleDispatchSource(identity, claim, effectId);
  if (captured.effect.kind !== "schedule_configure") reject();
  const { request, createEvidence } = await observeConfiguration(captured, evidence);
  if (scheduleEffectRequestDigest(request) !== captured.effect.request_digest) reject();
  await revalidateSession();
  assertOrganizationPlanChangeProviderBindingCurrent(
    captured.providerBinding,
    captured.source,
    captured.review.targetPlanKey,
    getCloudAwareEnv(),
  );
  const stripe = requireStripe();
  const started = await markOrganizationScheduleEffectDispatch(identity, claim, effectId);
  if (started.request_payload.kind !== "schedule_configure") reject();
  // The wire contract is validated against pinned Acacia. The installed SDK models a
  // newer API's duration field; never translate this request into that newer format.
  const raw = await stripe.subscriptionSchedules.update(
    started.request_payload.scheduleId,
    started.request_payload.params as unknown as Stripe.SubscriptionScheduleUpdateParams,
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
  const configuredEvidence = { kind: "response" as const, raw };
  const resolution = await observeAndFinalizeOrganizationScheduleConfiguration(identity, claim, {
    create: createEvidence,
    configuration: configuredEvidence,
  });
  return { effect, evidence: configuredEvidence, resolution };
}
