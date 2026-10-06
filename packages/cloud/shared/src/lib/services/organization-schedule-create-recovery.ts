/** Authenticated original-create observation shared by interactive and unattended recovery. */
import { ElizaError } from "@elizaos/core";
import {
  readOrganizationScheduleRecoverySource,
  recordAuthenticatedOrganizationScheduleEvidence,
} from "../../db/repositories/organization-schedule-effects";
import { requireStripe } from "../stripe";
import { findOriginalScheduleEvent } from "./organization-schedule-event-search";

type Identity = Parameters<typeof readOrganizationScheduleRecoverySource>[0];
type Claim = Parameters<typeof readOrganizationScheduleRecoverySource>[1];
type Evidence = { kind: "response" | "event"; raw: unknown };
export async function recoverOriginalOrganizationScheduleCreate(
  identity: Identity,
  claim: Claim,
): Promise<Evidence> {
  const context = await readOrganizationScheduleRecoverySource(identity, claim);
  const create = context.effects.find((e) => e.kind === "schedule_create");
  if (!create || create.state === "ready" || !create.started_at)
    throw new ElizaError("Original started schedule creation required", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  const evidence: Evidence = {
    kind: "event",
    raw: (
      await findOriginalScheduleEvent({
        reader: requireStripe().events,
        originalRequest: {
          request: create.request_payload,
          providerIdempotencyKey: create.provider_idempotency_key,
          customerId: create.customer_id,
          subscriptionId: create.subscription_id,
          livemode: create.livemode,
          startedAt: create.started_at,
        },
        observedAt: new Date(),
      })
    ).raw,
  };
  if (create.state === "started")
    await recordAuthenticatedOrganizationScheduleEvidence(identity, claim, create.id, evidence);
  return evidence;
}
