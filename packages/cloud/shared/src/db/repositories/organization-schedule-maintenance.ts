/** Due selection and scoped incidents reuse the existing command/financial journals. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, exists, isNull, not, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import { organizationPlanChangeQuotes as quotes } from "../schemas/organization-plan-change-quotes";
import { organizations } from "../schemas/organizations";
import {
  billingSubscriptionCommands as commands,
  billingSubscriptionIncidents as incidents,
} from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const owner = "organization_schedule_recovery";
function reject(reason: string): never {
  throw new ElizaError("Original schedule recovery authority is unavailable", {
    code: "SUBSCRIPTION_SCHEDULE_RECOVERY_UNAVAILABLE",
    context: { reason },
  });
}
export async function listOrganizationScheduleRecovery(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) reject("invalid_batch_limit");
  return dbWrite
    .select({
      id: commands.id,
      organization_id: commands.organization_id,
      requested_by_user_id: commands.requested_by_user_id,
    })
    .from(commands)
    .where(
      and(
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
        eq(commands.merchant_key, "platform"),
        eq(commands.kind, "downgrade"),
        or(
          eq(commands.status, "OUTCOME_UNKNOWN"),
          and(
            eq(commands.status, "PREPARED"),
            exists(
              dbWrite
                .select({ id: quotes.id })
                .from(quotes)
                .where(
                  and(
                    eq(quotes.consumed_by_command_id, commands.id),
                    eq(quotes.organization_id, commands.organization_id),
                    sql`${quotes.expires_at} <= clock_timestamp()`,
                  ),
                ),
            ),
          ),
        ),
        not(
          exists(
            dbWrite
              .select({ id: incidents.id })
              .from(incidents)
              .where(
                and(
                  eq(incidents.organization_id, commands.organization_id),
                  eq(incidents.command_id, commands.id),
                  isNull(incidents.billing_scope_id),
                  eq(incidents.status, "open"),
                  sql`${incidents.context}->>'owner' = ${owner}`,
                  sql`${incidents.next_retry_at} > clock_timestamp()`,
                ),
              ),
          ),
        ),
        sql`(${commands.lease_expires_at} IS NULL OR ${commands.lease_expires_at} <= clock_timestamp())`,
        sql`${commands.updated_at} <= clock_timestamp() - make_interval(secs => LEAST(3600,60*power(2,LEAST(GREATEST(${commands.attempt_count}-1,0),6)))::integer)`,
      ),
    )
    .orderBy(asc(commands.updated_at), asc(commands.id))
    .limit(limit);
}
/** Caller holds the organization lock; only a proven terminal original command closes incidents. */
export async function resolveOrganizationScheduleIncidentsInTransaction(
  tx: DbTransaction,
  input: { organizationId: string; commandId: string },
) {
  const now = await readPostLockDatabaseNow(tx);
  const rows = await tx
    .update(incidents)
    .set({
      status: "resolved",
      resolution: "Original schedule command reached its proven terminal result",
      resolved_at: now,
      resolved_by_user_id: null,
      next_retry_at: null,
      updated_at: now,
    })
    .where(
      and(
        eq(incidents.organization_id, input.organizationId),
        eq(incidents.command_id, input.commandId),
        isNull(incidents.billing_scope_id),
        eq(incidents.kind, "reconciliation"),
        eq(incidents.status, "open"),
        sql`${incidents.context}->>'owner' = ${owner}`,
        exists(
          tx
            .select({ id: commands.id })
            .from(commands)
            .where(
              and(
                eq(commands.id, input.commandId),
                eq(commands.organization_id, input.organizationId),
                isNull(commands.app_id),
                isNull(commands.billing_scope_id),
                eq(commands.merchant_key, "platform"),
                eq(commands.kind, "downgrade"),
                or(
                  and(
                    eq(commands.status, "APPLIED"),
                    sql`${commands.organization_schedule_configuration_evidence} IS NOT NULL`,
                  ),
                  and(
                    eq(commands.status, "FAILED"),
                    or(
                      sql`${commands.organization_schedule_failure_evidence} IS NOT NULL`,
                      eq(commands.error_code, "DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH"),
                    ),
                  ),
                  and(
                    eq(commands.status, "SUPERSEDED"),
                    eq(commands.error_code, "DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH"),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: incidents.id });
  return rows.length;
}
export async function recordOrganizationScheduleRecoveryOutcome(input: {
  organizationId: string;
  commandId: string;
  issueCode: string | null;
}) {
  if (input.issueCode !== null && !/^[A-Z][A-Z0-9_]{0,119}$/.test(input.issueCode))
    reject("invalid_incident_code");
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) reject("organization_missing");
    const [command] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.organization_id, input.organizationId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
        ),
      )
      .for("update");
    if (
      !command ||
      command.kind !== "downgrade" ||
      command.merchant_key !== "platform" ||
      !command.subscription_id ||
      !["PREPARED", "OUTCOME_UNKNOWN", "APPLIED", "FAILED", "SUPERSEDED"].includes(command.status)
    )
      reject("command_unavailable");
    if (["APPLIED", "FAILED", "SUPERSEDED"].includes(command.status))
      return {
        recorded: false,
        resolved: await resolveOrganizationScheduleIncidentsInTransaction(tx, input),
      };
    if (input.issueCode === null) return { recorded: false, resolved: 0 };
    const now = await readPostLockDatabaseNow(tx),
      nextRetryAt = new Date(
        now.getTime() +
          Math.min(3600, 60 * 2 ** Math.min(Math.max(command.attempt_count - 1, 0), 6)) * 1000,
      ),
      fingerprint = createHash("sha256")
        .update(`${owner}:${command.id}:${input.issueCode}`)
        .digest("hex");
    const [created] = await tx
      .insert(incidents)
      .values({
        organization_id: input.organizationId,
        subscription_id: command.subscription_id,
        command_id: command.id,
        event_receipt_id: null,
        kind: "reconciliation",
        severity: "error",
        fingerprint,
        context: { owner, code: input.issueCode },
        next_retry_at: nextRetryAt,
        first_observed_at: now,
        last_observed_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing()
      .returning({ id: incidents.id });
    if (!created) {
      const updated = await tx
        .update(incidents)
        .set({
          occurrence_count: sql`${incidents.occurrence_count}+1`,
          next_retry_at: nextRetryAt,
          last_observed_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(incidents.organization_id, input.organizationId),
            eq(incidents.subscription_id, command.subscription_id),
            eq(incidents.command_id, command.id),
            isNull(incidents.billing_scope_id),
            eq(incidents.status, "open"),
            eq(incidents.fingerprint, fingerprint),
          ),
        )
        .returning({ id: incidents.id });
      if (updated.length !== 1) reject("incident_conflict");
    }
    return { recorded: true, resolved: 0 };
  });
}
