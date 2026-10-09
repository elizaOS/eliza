/** Read-only original configuration recovery and publication. Never issues another provider write. */
import {
  readOrganizationSchedulePublicationSource,
  recordAuthenticatedOrganizationScheduleEvidence,
} from "../../db/repositories/organization-schedule-effects";
import { finalizeConfiguredOrganizationSchedule } from "../../db/repositories/organization-schedule-finalization";
import { requireStripe } from "../stripe";
import { findOriginalScheduleEvent } from "./organization-schedule-event-search";

type Identity = { organizationId: string; actorId: string; commandId: string };
type Claim = { commandId: string; leaseToken: string; generation: number };
type Evidence = { kind: "response" | "event"; raw: unknown };
export async function observeAndFinalizeOrganizationScheduleConfiguration(
  identity: Identity,
  claim: Claim,
  evidence?: { create: Evidence; configuration: Evidence },
) {
  const captured = await readOrganizationSchedulePublicationSource(identity, claim);
  if (captured.kind === "terminal") return { command: captured.command, replayed: true };
  const stripe = requireStripe(),
    options = { apiVersion: captured.apiVersion };
  const find = async (effect: typeof captured.configuration): Promise<Evidence> => ({
    kind: "event",
    raw: (
      await findOriginalScheduleEvent({
        reader: stripe.events,
        originalRequest: {
          request: effect.request_payload,
          providerIdempotencyKey: effect.provider_idempotency_key,
          customerId: effect.customer_id,
          subscriptionId: effect.subscription_id,
          livemode: effect.livemode,
          startedAt: effect.started_at!,
        },
        observedAt: new Date(),
      })
    ).raw,
  });
  const createEvidence = evidence?.create ?? (await find(captured.create));
  const configurationEvidence = evidence?.configuration ?? (await find(captured.configuration));
  // An existing response receipt is immutable. The event is only supplementary evidence,
  // validated against that complete original snapshot by the locked finalizer.
  if (captured.configuration.state === "started")
    await recordAuthenticatedOrganizationScheduleEvidence(
      identity,
      claim,
      captured.configuration.id,
      configurationEvidence,
    );
  const rawCustomer = await stripe.customers.retrieve(
    captured.create.customer_id,
    { expand: ["tax_ids"] },
    options,
  );
  const rawSubscription = await stripe.subscriptions.retrieve(
    captured.create.subscription_id,
    {},
    options,
  );
  const rawCurrentSchedule = await stripe.subscriptionSchedules.retrieve(
    captured.create.receipt!.scheduleId,
    {},
    options,
  );
  return finalizeConfiguredOrganizationSchedule({
    ...identity,
    leaseToken: claim.leaseToken,
    executionGeneration: claim.generation,
    createEvidence,
    configurationEvidence,
    rawCustomer,
    rawSubscription,
    rawCurrentSchedule,
  });
}
