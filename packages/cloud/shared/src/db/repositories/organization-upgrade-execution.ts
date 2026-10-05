/** Owns upgrade dispatch leases. Provider I/O remains outside database transactions. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { organizationUpgradeReviewSchema } from "../../lib/services/organization-plan-change-contract";
import {
  organizationUpgradeIntentDigest,
  organizationUpgradeProviderBindingSchema,
} from "../../lib/services/organization-upgrade-provider-binding";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { lockOrganizationPlanChangeSource } from "./organization-plan-change";
import {
  lockOrganizationSubscriptionManager,
  type OrganizationSubscriptionIdentity,
} from "./organization-subscription-manager";
import { readPostLockDatabaseNow } from "./primary-database-clock";

type Identity = OrganizationSubscriptionIdentity & { commandId: string };
function reject(reason: string): never {
  throw new ElizaError("Organization upgrade execution requires current original authority", {
    code:
      reason === "current_manager_required" || reason === "organization_authority_unavailable"
        ? "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN"
        : "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    context: { reason },
  });
}
async function lockExecution(tx: DbTransaction, input: Identity) {
  const manager = await lockOrganizationSubscriptionManager(tx, input, reject);
  return { ...(await lockOriginalExecution(tx, input)), manager };
}
/** Cleanup cannot grant an effect. Original identity and current lease survive manager revocation. */
async function lockCleanup(tx: DbTransaction, input: Identity) {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (!organization) reject("organization_authority_unavailable");
  return lockOriginalExecution(tx, input);
}
async function lockOriginalExecution(tx: DbTransaction, input: Identity) {
  const [command] = await tx
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.id, input.commandId),
        eq(commands.organization_id, input.organizationId),
        eq(commands.requested_by_user_id, input.actorId),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
      ),
    )
    .for("update");
  if (
    !command ||
    command.kind !== "upgrade" ||
    command.merchant_key !== "platform" ||
    !command.subscription_id ||
    command.expected_subscription_revision === null ||
    command.organization_upgrade_dispatch_state === null
  )
    reject("command_unavailable");
  const [quote] = await tx
    .select()
    .from(organizationPlanChangeQuotes)
    .where(
      and(
        eq(organizationPlanChangeQuotes.consumed_by_command_id, command.id),
        eq(organizationPlanChangeQuotes.organization_id, input.organizationId),
        eq(organizationPlanChangeQuotes.actor_id, input.actorId),
      ),
    )
    .for("update");
  if (
    !quote ||
    quote.subscription_id !== command.subscription_id ||
    quote.subscription_revision !== command.expected_subscription_revision ||
    quote.target_plan_key !== command.target_plan_key ||
    quote.review_digest !== settlementDigest(quote.review) ||
    command.request_digest !==
      organizationUpgradeIntentDigest({
        organizationId: input.organizationId,
        actorId: input.actorId,
        quoteId: quote.id,
        reviewDigest: quote.review_digest,
        sourceDigest: quote.source_digest,
        providerBinding: quote.provider_binding,
      })
  )
    reject("command_review_changed");
  const review = organizationUpgradeReviewSchema.parse(quote.review);
  return { command, quote: { ...quote, review } };
}
async function currentSource(
  tx: DbTransaction,
  input: Identity,
  locked: Awaited<ReturnType<typeof lockExecution>>,
) {
  const current = await lockOrganizationPlanChangeSource(
    tx,
    {
      ...input,
      subscriptionId: locked.quote.subscription_id,
      expectedSubscriptionRevision: locked.quote.subscription_revision,
    },
    locked.command.id,
  );
  if (locked.quote.source_digest !== settlementDigest(current)) reject("source_changed");
  return current;
}
/** A started claim can only observe/reconcile; ready claims still need markOrganizationUpgradeDispatch. */
export async function claimOrganizationUpgrade(input: Identity) {
  return writeTransaction(async (tx) => {
    const locked = await lockExecution(tx, input);
    const { command, quote } = locked;
    if (command.status !== "PREPARED" && command.status !== "OUTCOME_UNKNOWN") return null;
    const now = await readPostLockDatabaseNow(tx);
    if (command.lease_expires_at && command.lease_expires_at > now) return null;
    if (
      command.organization_upgrade_dispatch_state === "ready" &&
      (quote.expires_at <= now || quote.provider_binding === null)
    ) {
      await tx
        .update(commands)
        .set({
          status: command.status === "PREPARED" ? "SUPERSEDED" : "FAILED",
          error_code:
            quote.provider_binding === null
              ? "UPGRADE_BINDING_UNAVAILABLE_BEFORE_DISPATCH"
              : "UPGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH",
          completed_at: now,
          updated_at: now,
          state_revision: command.state_revision + 1,
          lease_token: null,
          lease_expires_at: null,
        })
        .where(eq(commands.id, command.id));
      return null;
    }
    // Recovery does not require the old paid period still to be active. Finalization
    // must independently verify source revision and must never revive expired allowance.
    // Claim before re-observation so a changed source can be terminalized safely.
    // The dispatch boundary independently rechecks source/quote/manager authority.
    const [claimed] = await tx
      .update(commands)
      .set({
        status: "OUTCOME_UNKNOWN",
        state_revision: command.state_revision + 1,
        execution_generation: command.execution_generation + 1,
        attempt_count: command.attempt_count + 1,
        lease_token: randomUUID(),
        lease_expires_at: new Date(now.getTime() + 60_000),
        provider_started_at: command.provider_started_at ?? now,
        updated_at: now,
      })
      .where(eq(commands.id, command.id))
      .returning();
    if (!claimed) reject("claim_failed");
    return {
      command: claimed,
      quote,
      organizationCustomerId: locked.manager.organization.customer,
      canDispatch: command.organization_upgrade_dispatch_state === "ready",
    };
  });
}
export type OrganizationUpgradeClaim = NonNullable<
  Awaited<ReturnType<typeof claimOrganizationUpgrade>>
>;
function assertLease(
  command: typeof commands.$inferSelect,
  claim: OrganizationUpgradeClaim,
  now: Date,
) {
  if (
    command.status !== "OUTCOME_UNKNOWN" ||
    command.lease_token !== claim.command.lease_token ||
    command.execution_generation !== claim.command.execution_generation ||
    !command.lease_expires_at ||
    command.lease_expires_at <= now
  )
    reject("command_lease_lost");
}
/** Revalidates source before provider re-preview; this read never grants dispatch permission. */
export async function readOrganizationUpgradeDispatchSource(
  input: Identity,
  claim: OrganizationUpgradeClaim,
) {
  return writeTransaction(async (tx) => {
    if (input.commandId !== claim.command.id) reject("claim_identity_changed");
    const locked = await lockExecution(tx, input);
    const now = await readPostLockDatabaseNow(tx);
    assertLease(locked.command, claim, now);
    if (
      locked.command.organization_upgrade_dispatch_state !== "ready" ||
      locked.quote.expires_at <= now
    )
      reject("review_unavailable_for_dispatch");
    return {
      ...(await currentSource(tx, input, locked)),
      review: locked.quote.review,
      providerBinding: organizationUpgradeProviderBindingSchema.parse(
        locked.quote.provider_binding,
      ),
    };
  });
}
/** Call after provider re-preview and session validation, immediately before the single provider write. */
export async function markOrganizationUpgradeDispatch(
  input: Identity,
  claim: OrganizationUpgradeClaim,
) {
  return writeTransaction(async (tx) => {
    if (input.commandId !== claim.command.id) reject("claim_identity_changed");
    const locked = await lockExecution(tx, input);
    assertLease(locked.command, claim, await readPostLockDatabaseNow(tx));
    if (locked.command.organization_upgrade_dispatch_state !== "ready")
      reject("dispatch_already_started");
    await currentSource(tx, input, locked);
    if (locked.quote.expires_at <= (await readPostLockDatabaseNow(tx))) reject("review_expired");
    const [row] = await tx
      .update(commands)
      .set({
        organization_upgrade_dispatch_state: "started",
        state_revision: sql`${commands.state_revision}+1`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.lease_token, claim.command.lease_token!),
          eq(commands.execution_generation, claim.command.execution_generation),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: commands.id });
    if (!row) reject("dispatch_lease_lost");
  });
}
/** Ends a provably unstarted review; started/unknown effects can never take this shortcut. */
export async function failOrganizationUpgradeBeforeDispatch(
  input: Identity,
  claim: OrganizationUpgradeClaim,
) {
  return writeTransaction(async (tx) => {
    if (input.commandId !== claim.command.id) reject("claim_identity_changed");
    const locked = await lockCleanup(tx, input);
    assertLease(locked.command, claim, await readPostLockDatabaseNow(tx));
    if (locked.command.organization_upgrade_dispatch_state !== "ready")
      reject("dispatch_already_started");
    const [row] = await tx
      .update(commands)
      .set({
        status: "FAILED",
        error_code: "UPGRADE_REVIEW_REJECTED_BEFORE_DISPATCH",
        state_revision: sql`${commands.state_revision}+1`,
        completed_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
        lease_token: null,
        lease_expires_at: null,
      })
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.lease_token, claim.command.lease_token!),
          eq(commands.execution_generation, claim.command.execution_generation),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: commands.id });
    if (!row) reject("failure_lease_lost");
  });
}
/** Releases the current lease without resetting dispatch provenance. */
export async function releaseOrganizationUpgrade(input: Identity, claim: OrganizationUpgradeClaim) {
  return writeTransaction(async (tx) => {
    if (input.commandId !== claim.command.id) reject("claim_identity_changed");
    const locked = await lockCleanup(tx, input);
    assertLease(locked.command, claim, await readPostLockDatabaseNow(tx));
    await tx
      .update(commands)
      .set({ lease_token: null, lease_expires_at: null, updated_at: sql`clock_timestamp()` })
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.lease_token, claim.command.lease_token!),
          eq(commands.execution_generation, claim.command.execution_generation),
        ),
      );
  });
}

/** Cleans up this attempt after an error without masking a concurrent terminal result or newer lease. */
export async function finishOrganizationUpgradeAttempt(
  input: Identity,
  claim: OrganizationUpgradeClaim,
) {
  return writeTransaction(async (tx) => {
    if (input.commandId !== claim.command.id) reject("claim_identity_changed");
    const { command } = await lockCleanup(tx, input);
    const now = await readPostLockDatabaseNow(tx);
    if (
      command.status !== "OUTCOME_UNKNOWN" ||
      command.lease_token !== claim.command.lease_token ||
      command.execution_generation !== claim.command.execution_generation ||
      !command.lease_expires_at ||
      command.lease_expires_at <= now
    )
      return command;
    const ready = command.organization_upgrade_dispatch_state === "ready";
    const [updated] = await tx
      .update(commands)
      .set({
        ...(ready
          ? {
              status: "FAILED" as const,
              error_code: "UPGRADE_REVIEW_REJECTED_BEFORE_DISPATCH",
              completed_at: sql`clock_timestamp()`,
            }
          : {}),
        state_revision: command.state_revision + 1,
        lease_token: null,
        lease_expires_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.id, command.id),
          eq(commands.lease_token, claim.command.lease_token!),
          eq(commands.execution_generation, claim.command.execution_generation),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    return updated ?? command;
  });
}
