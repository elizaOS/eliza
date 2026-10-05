/** Uses the existing financial incident journal under organization/command locks. */
import { createHash } from "node:crypto";
import { and, eq, exists, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import {
  billingSubscriptionCommands as commands,
  billingSubscriptionIncidents as incidents,
} from "../schemas/subscription-billing-operations";
import { upgradeSettlementConflict as reject } from "./organization-upgrade-paid-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const owner = "organization_upgrade_recovery";
export async function recordOrganizationUpgradeRecoveryOutcome(input: {
  organizationId: string;
  commandId: string;
  issueCode: string | null;
}) {
  if (input.issueCode !== null && !/^[A-Z][A-Z0-9_]{0,119}$/.test(input.issueCode))
    reject("invalid_recovery_incident_code");
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
      command.kind !== "upgrade" ||
      command.merchant_key !== "platform" ||
      command.organization_upgrade_dispatch_state !== "started" ||
      !command.subscription_id ||
      (!["OUTCOME_UNKNOWN", "APPLIED"].includes(command.status) &&
        !(command.status === "FAILED" && command.organization_upgrade_failure_evidence !== null))
    )
      reject("original_upgrade_unavailable");
    const now = await readPostLockDatabaseNow(tx);
    if (command.status === "FAILED")
      return {
        recorded: false,
        resolved: await resolveVoidedUpgradeIncidentsInTransaction(tx, input),
      };
    if (command.status === "APPLIED") {
      return {
        recorded: false,
        resolved: await resolveAppliedUpgradeIncidentsInTransaction(tx, input),
      };
    }
    if (input.issueCode === null) return { recorded: false, resolved: 0 };
    const fingerprint = createHash("sha256")
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
        next_retry_at: null,
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
      if (updated.length !== 1) reject("recovery_incident_conflict");
    }
    return { recorded: true, resolved: 0 };
  });
}

/** Caller holds the organization lock. Publication and replay close only proven applied original-command incidents. */
export async function resolveAppliedUpgradeIncidentsInTransaction(
  tx: DbTransaction,
  input: {
    organizationId: string;
    commandId: string;
  },
) {
  return resolveUpgradeIncidents(tx, input, "APPLIED");
}

export async function resolveVoidedUpgradeIncidentsInTransaction(
  tx: DbTransaction,
  input: { organizationId: string; commandId: string },
) {
  return resolveUpgradeIncidents(tx, input, "FAILED");
}
async function resolveUpgradeIncidents(
  tx: DbTransaction,
  input: { organizationId: string; commandId: string },
  status: "APPLIED" | "FAILED",
) {
  const now = await readPostLockDatabaseNow(tx);
  const resolved = await tx
    .update(incidents)
    .set({
      status: "resolved",
      resolution:
        status === "APPLIED"
          ? "Original upgrade result applied"
          : "Original upgrade invoice void; no upgrade applied",
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
        eq(incidents.status, "open"),
        eq(incidents.kind, "reconciliation"),
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
                eq(commands.kind, "upgrade"),
                eq(commands.organization_upgrade_dispatch_state, "started"),
                eq(commands.status, status),
                status === "FAILED"
                  ? isNotNull(commands.organization_upgrade_failure_evidence)
                  : undefined,
              ),
            ),
        ),
        sql`${incidents.context}->>'owner' = ${owner}`,
      ),
    )
    .returning({ id: incidents.id });
  return resolved.length;
}
