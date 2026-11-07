/** System observation lease may recover missing receipts but never dispatch. */
import { randomUUID } from "node:crypto";
import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { upgradeSettlementConflict as reject } from "./organization-upgrade-paid-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";
export async function claimOrganizationUpgradeObservation(input: {
  organizationId: string;
  commandId: string;
}) {
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({
        id: organizations.id,
        active: organizations.is_active,
        state: organizations.account_lifecycle_state,
        deletion: organizations.account_deletion_request_id,
        fenced: organizations.paid_work_fenced_at,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (
      !org ||
      !org.active ||
      org.state !== "active" ||
      org.deletion !== null ||
      org.fenced !== null
    )
      return null;
    const [command] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          eq(commands.id, input.commandId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !command ||
      command.kind !== "upgrade" ||
      command.merchant_key !== "platform" ||
      command.status !== "OUTCOME_UNKNOWN" ||
      command.organization_upgrade_dispatch_state !== "started" ||
      (command.lease_expires_at !== null && command.lease_expires_at > now)
    )
      return null;
    const [claimed] = await tx
      .update(commands)
      .set({
        lease_token: randomUUID(),
        lease_expires_at: new Date(now.getTime() + 60000),
        execution_generation: command.execution_generation + 1,
        attempt_count: command.attempt_count + 1,
        state_revision: command.state_revision + 1,
        updated_at: now,
      })
      .where(eq(commands.id, command.id))
      .returning();
    if (!claimed) reject("reconciliation_claim_failed");
    return { command: claimed, canDispatch: false as const };
  });
}

/** Due selection is advisory; the leased claim serializes workers and rechecks fences. */
export async function listOrganizationUpgradeRecovery(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
    reject("invalid_recovery_batch_limit");
  return dbWrite
    .select(getTableColumns(commands))
    .from(commands)
    .innerJoin(organizations, eq(organizations.id, commands.organization_id))
    .where(
      and(
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.account_deletion_request_id),
        isNull(organizations.paid_work_fenced_at),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
        eq(commands.merchant_key, "platform"),
        eq(commands.kind, "upgrade"),
        eq(commands.status, "OUTCOME_UNKNOWN"),
        eq(commands.organization_upgrade_dispatch_state, "started"),
        sql`(${commands.lease_expires_at} IS NULL OR ${commands.lease_expires_at} <= clock_timestamp())`,
        sql`${commands.updated_at} <= clock_timestamp() - make_interval(secs => LEAST(3600, 60 * power(2, LEAST(GREATEST(${commands.attempt_count} - 1, 0), 6)))::integer)`,
      ),
    )
    .orderBy(asc(commands.updated_at), asc(commands.id))
    .limit(limit);
}
