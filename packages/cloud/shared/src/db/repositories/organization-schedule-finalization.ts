/** Atomically publishes verified pending schedule state; current paid plan and allowance remain unchanged. */

import { ElizaError } from "@elizaos/core";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import type {
  OrganizationScheduleConfiguredIdentity,
  OrganizationScheduleConfiguredObservation,
} from "./organization-schedule-effects";
import { resolveOrganizationScheduleIncidentsInTransaction } from "./organization-schedule-maintenance";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";

function reject(): never {
  throw new ElizaError("Original configured schedule cannot be published", {
    code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
  });
}
export async function finalizeConfiguredOrganizationSchedule(
  input: OrganizationScheduleConfiguredIdentity & OrganizationScheduleConfiguredObservation,
) {
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) reject();
    // Organization lock serializes command writers. Do not lock the command before the association.
    const [existing] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.organization_id, input.organizationId),
          eq(commands.requested_by_user_id, input.actorId),
          isNull(commands.billing_scope_id),
          isNull(commands.app_id),
        ),
      );
    if (!existing || existing.kind !== "downgrade" || existing.merchant_key !== "platform")
      reject();
    if (
      existing.status === "APPLIED" &&
      existing.organization_schedule_configuration_evidence !== null
    )
      return { command: existing, replayed: true };
    const verified =
      await subscriptionAuthorityRepository.advanceConfiguredOrganizationScheduleInTransaction(
        tx,
        input,
      );
    await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: input.organizationId,
      sourceSubscriptionId: verified.source.id,
      sourceSubscriptionRevision: verified.subscription.lifecycle_revision,
      expectedProjectionRevision: verified.projection.projection_revision,
    });
    const [applied] = await tx
      .update(commands)
      .set({
        status: "APPLIED",
        state_revision: verified.command.state_revision + 1,
        lease_token: null,
        lease_expires_at: null,
        organization_schedule_configuration_evidence: verified.proof,
        organization_schedule_configuration_snapshot: verified.configuredSnapshot,
        provider_response_digest: settlementDigest(verified.proof),
        result_subscription_id: verified.source.id,
        result_subscription_revision: verified.subscription.lifecycle_revision,
        completed_at: sql`clock_timestamp()`,
        applied_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.organization_id, input.organizationId),
          eq(commands.status, "OUTCOME_UNKNOWN"),
          eq(commands.lease_token, input.leaseToken),
          eq(commands.execution_generation, input.executionGeneration),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!applied) reject();
    await resolveOrganizationScheduleIncidentsInTransaction(tx, input);
    return { command: applied, replayed: false };
  });
}
