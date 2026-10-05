/** Prove and retire original partial-create cleanup without changing the paid plan or allowance. */
import { ElizaError } from "@elizaos/core";
import {
  finalizeOrganizationScheduleCompensation,
  markOrganizationScheduleCompensationDispatch,
  prepareOrganizationScheduleCompensation,
  readOrganizationScheduleCompensationSource,
  recordAuthenticatedOrganizationScheduleEvidence,
} from "../../db/repositories/organization-schedule-effects.ts";
import { requireStripe } from "../stripe";
import { assertOrganizationScheduleAttachedTermsCurrent } from "./organization-schedule-attached-terms";
import { findOriginalScheduleEvent } from "./organization-schedule-event-search";

type Identity = { organizationId: string; actorId: string; commandId: string };
type Claim = { commandId: string; leaseToken: string; generation: number };
type Evidence = { kind: "response" | "event"; raw: unknown };
export async function compensateOrganizationScheduleCreate(
  identity: Identity,
  claim: Claim,
  originalEvidence?: Evidence,
) {
  const first = await readOrganizationScheduleCompensationSource(identity, claim),
    create = first.create;
  if (!create.receipt || !create.started_at)
    throw new ElizaError("Original create proof unavailable", {
      code: "SUBSCRIPTION_SCHEDULE_ORIGIN_UNVERIFIED",
    });
  const stripe = requireStripe(),
    options = { apiVersion: first.providerBinding.apiVersion };
  const originalRequest = {
    request: create.request_payload,
    providerIdempotencyKey: create.provider_idempotency_key,
    customerId: create.customer_id,
    subscriptionId: create.subscription_id,
    livemode: create.livemode,
    startedAt: create.started_at,
  };
  const evidence = originalEvidence ?? {
    kind: "event" as const,
    raw: (
      await findOriginalScheduleEvent({
        reader: stripe.events,
        originalRequest,
        observedAt: new Date(),
      })
    ).raw,
  };
  async function observe() {
    const current = await readOrganizationScheduleCompensationSource(identity, claim);
    const rawCustomer = await stripe.customers.retrieve(
      create.customer_id,
      { expand: ["tax_ids"] },
      options,
    );
    const rawSubscription = await stripe.subscriptions.retrieve(
      create.subscription_id,
      {},
      options,
    );
    const rawCurrentSchedule = await stripe.subscriptionSchedules.retrieve(
      create.receipt!.scheduleId,
      {},
      options,
    );
    const originalCreate = {
      originalReceipt: create.receipt,
      originalRequest,
      evidence,
      observedAt: new Date(),
    };
    assertOrganizationScheduleAttachedTermsCurrent({
      ...originalCreate,
      originalTerms: current.retainedTerms,
      rawCustomer,
      rawSubscription,
      rawCurrentSchedule,
    });
    return originalCreate;
  }
  await observe();
  const release = await prepareOrganizationScheduleCompensation(identity, claim);
  await observe();
  const started = await markOrganizationScheduleCompensationDispatch(identity, claim, release.id);
  if (started.request_payload.kind !== "schedule_release" || !started.started_at)
    throw new ElizaError("Original release request changed", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  const raw = await stripe.subscriptionSchedules.release(
    started.request_payload.scheduleId,
    started.request_payload.params,
    { ...options, idempotencyKey: started.provider_idempotency_key, maxNetworkRetries: 0 },
  );
  const effect = await recordAuthenticatedOrganizationScheduleEvidence(
    identity,
    claim,
    started.id,
    { kind: "response", raw },
  );
  const observation = await readReleasedState(
    first,
    effect,
    evidence,
    { kind: "response", raw },
    stripe,
  );
  const resolution = await finalizeOrganizationScheduleCompensation(identity, claim, observation);
  return { effect, resolution };
}

type Context = Awaited<ReturnType<typeof readOrganizationScheduleCompensationSource>>;
function originalRequestFor(effect: Context["create"]) {
  if (!effect.started_at)
    throw new ElizaError("Original schedule dispatch provenance unavailable", {
      code: "SUBSCRIPTION_SCHEDULE_ORIGIN_UNVERIFIED",
    });
  return {
    request: effect.request_payload,
    providerIdempotencyKey: effect.provider_idempotency_key,
    customerId: effect.customer_id,
    subscriptionId: effect.subscription_id,
    livemode: effect.livemode,
    startedAt: effect.started_at,
  };
}
async function readReleasedState(
  context: Context,
  effect: Context["create"],
  createEvidence: Evidence,
  releaseEvidence: Evidence,
  stripe: ReturnType<typeof requireStripe>,
) {
  const create = context.create;
  if (!create.receipt || !effect.receipt)
    throw new ElizaError("Original schedule receipt unavailable", {
      code: "SUBSCRIPTION_SCHEDULE_ORIGIN_UNVERIFIED",
    });
  const options = { apiVersion: context.providerBinding.apiVersion };
  const rawSubscription = await stripe.subscriptions.retrieve(create.subscription_id, {}, options);
  const rawCustomer = await stripe.customers.retrieve(
    create.customer_id,
    { expand: ["tax_ids"] },
    options,
  );
  const rawCurrentSchedule = await stripe.subscriptionSchedules.retrieve(
    create.receipt.scheduleId,
    {},
    options,
  );
  return { createEvidence, releaseEvidence, rawCurrentSchedule, rawSubscription, rawCustomer };
}

/** Reconcile an already-started release with authenticated original events. Never POSTs.
 * An observed response receipt is retained; its supplemental event must reconstruct
 * the same complete snapshot rather than replace the immutable receipt.
 */
export async function recoverOrganizationScheduleCompensation(identity: Identity, claim: Claim) {
  const context = await readOrganizationScheduleCompensationSource(identity, claim),
    release = context.release;
  if (
    !release ||
    release.kind !== "schedule_release" ||
    release.state === "ready" ||
    !release.started_at
  )
    throw new ElizaError("Only an original started release can be recovered", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  const stripe = requireStripe();
  const createEvidence: Evidence = {
    kind: "event",
    raw: (
      await findOriginalScheduleEvent({
        reader: stripe.events,
        originalRequest: originalRequestFor(context.create),
        observedAt: new Date(),
      })
    ).raw,
  };
  const releaseEvidence: Evidence = {
    kind: "event",
    raw: (
      await findOriginalScheduleEvent({
        reader: stripe.events,
        originalRequest: originalRequestFor(release),
        observedAt: new Date(),
      })
    ).raw,
  };
  const effect =
    release.state === "observed"
      ? release
      : await recordAuthenticatedOrganizationScheduleEvidence(
          identity,
          claim,
          release.id,
          releaseEvidence,
        );
  const observation = await readReleasedState(
    context,
    effect,
    createEvidence,
    releaseEvidence,
    stripe,
  );
  const resolution = await finalizeOrganizationScheduleCompensation(identity, claim, observation);
  return { effect, resolution };
}
