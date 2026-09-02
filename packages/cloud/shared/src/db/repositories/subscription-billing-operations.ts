/**
 * Owns durable subscription command, webhook receipt, incident, and deletion-fence transitions.
 * Provider calls remain outside this module; every mutation is an exact database CAS or replay.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  type BillingSubscriptionCommand,
  type BillingSubscriptionCommandKind,
  type BillingSubscriptionEventReceipt,
  type BillingSubscriptionIncident,
  type BillingSubscriptionIncidentKind,
  type BillingSubscriptionIncidentSeverity,
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
  billingSubscriptionIncidents,
  type SubscriptionBillingFence,
  type SubscriptionBillingFenceState,
  subscriptionBillingFences,
} from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export const SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT = "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT";
export const SUBSCRIPTION_BILLING_OPERATIONS_INVALID = "SUBSCRIPTION_BILLING_OPERATIONS_INVALID";

export interface RepositoryMutation<T> {
  value: T;
  replayed: boolean;
}

export interface EnqueueSubscriptionCommandInput {
  id?: string;
  organizationId: string;
  subscriptionId: string | null;
  requestedByUserId: string;
  kind: BillingSubscriptionCommandKind;
  targetPlanKey: "plus_monthly" | "pro_monthly" | null;
  expectedSubscriptionRevision: number | null;
  idempotencyKey: string;
  providerIdempotencyKey: string;
  requestDigest: string;
  now: Date;
}

export interface RecordSubscriptionEventInput {
  id?: string;
  organizationId: string;
  subscriptionId: string;
  providerEventId: string;
  eventType: string;
  providerObjectType: "subscription" | "invoice";
  providerObjectId: string;
  livemode: boolean;
  eventCreatedAt: Date;
  payloadDigest: string;
  now: Date;
}

export interface CreateSubscriptionFenceInput {
  id?: string;
  organizationId: string;
  subscriptionId: string;
  providerEventId: string | null;
  providerEventCreatedAt: Date | null;
  providerObjectDigest: string;
  nextReconcileAt: Date | null;
  now: Date;
}

export interface AdvanceSubscriptionFenceInput {
  organizationId: string;
  subscriptionId: string;
  expectedFenceRevision: number;
  state: SubscriptionBillingFenceState;
  providerEventId: string | null;
  providerEventCreatedAt: Date | null;
  providerObjectDigest: string;
  deletionRequestedAt: Date | null;
  providerDeletedAt: Date | null;
  releasedAt: Date | null;
  lastReconciledAt: Date | null;
  nextReconcileAt: Date | null;
  now: Date;
}

function conflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT,
    context,
    severity: "fatal",
  });
}

function invalid(message: string, field: string): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_BILLING_OPERATIONS_INVALID,
    context: { field },
  });
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    invalid(`${field} is invalid`, field);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === right || (left !== null && right !== null && left.getTime() === right.getTime());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function exactCommandReplay(
  row: BillingSubscriptionCommand,
  input: EnqueueSubscriptionCommandInput,
) {
  return (
    (input.id === undefined || row.id === input.id) &&
    row.organization_id === input.organizationId &&
    row.subscription_id === input.subscriptionId &&
    row.requested_by_user_id === input.requestedByUserId &&
    row.kind === input.kind &&
    row.target_plan_key === input.targetPlanKey &&
    row.expected_subscription_revision === input.expectedSubscriptionRevision &&
    row.idempotency_key === input.idempotencyKey &&
    row.provider_idempotency_key === input.providerIdempotencyKey &&
    row.request_digest === input.requestDigest
  );
}

function exactEventReplay(
  row: BillingSubscriptionEventReceipt,
  input: RecordSubscriptionEventInput,
) {
  return (
    (input.id === undefined || row.id === input.id) &&
    row.organization_id === input.organizationId &&
    row.subscription_id === input.subscriptionId &&
    row.provider_event_id === input.providerEventId &&
    row.event_type === input.eventType &&
    row.provider_object_type === input.providerObjectType &&
    row.provider_object_id === input.providerObjectId &&
    row.livemode === input.livemode &&
    sameDate(row.event_created_at, input.eventCreatedAt) &&
    row.payload_digest === input.payloadDigest
  );
}

function exactFence(row: SubscriptionBillingFence, input: AdvanceSubscriptionFenceInput): boolean {
  return (
    row.fence_revision === input.expectedFenceRevision + 1 &&
    row.state === input.state &&
    row.provider_event_id === input.providerEventId &&
    sameDate(row.provider_event_created_at, input.providerEventCreatedAt) &&
    row.provider_object_digest === input.providerObjectDigest &&
    sameDate(row.deletion_requested_at, input.deletionRequestedAt) &&
    sameDate(row.provider_deleted_at, input.providerDeletedAt) &&
    sameDate(row.released_at, input.releasedAt) &&
    sameDate(row.last_reconciled_at, input.lastReconciledAt) &&
    sameDate(row.next_reconcile_at, input.nextReconcileAt)
  );
}

export class SubscriptionBillingOperationsRepository {
  async findCommand(
    organizationId: string,
    commandId: string,
  ): Promise<BillingSubscriptionCommand | undefined> {
    const [row] = await dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, organizationId),
          eq(billingSubscriptionCommands.id, commandId),
        ),
      )
      .limit(1);
    return row;
  }

  async enqueueCommand(
    input: EnqueueSubscriptionCommandInput,
  ): Promise<RepositoryMutation<BillingSubscriptionCommand>> {
    requireDate(input.now, "now");
    return writeTransaction(async (tx) => {
      if (input.kind === "checkout") {
        const [organization] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId))
          .limit(1)
          .for("update");
        if (!organization) {
          return conflict("Checkout organization does not exist", {
            organizationId: input.organizationId,
          });
        }
        const [replay] = await tx
          .select()
          .from(billingSubscriptionCommands)
          .where(
            and(
              eq(billingSubscriptionCommands.organization_id, input.organizationId),
              eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (replay) {
          if (!exactCommandReplay(replay, input)) {
            conflict("Subscription command idempotency replay differs from the stored intent", {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            });
          }
          return { value: replay, replayed: true };
        }
        const [liveSubscription] = await tx
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.organization_id, input.organizationId),
              inArray(billingSubscriptions.status, [
                "pending",
                "incomplete",
                "active",
                "grace",
                "past_due",
                "unpaid",
              ]),
            ),
          )
          .limit(1);
        if (liveSubscription) {
          conflict("Organization already has live subscription authority", {
            organizationId: input.organizationId,
            subscriptionId: liveSubscription.id,
          });
        }
      }
      const [created] = await tx
        .insert(billingSubscriptionCommands)
        .values({
          id: input.id,
          organization_id: input.organizationId,
          subscription_id: input.subscriptionId,
          requested_by_user_id: input.requestedByUserId,
          kind: input.kind,
          target_plan_key: input.targetPlanKey,
          expected_subscription_revision: input.expectedSubscriptionRevision,
          idempotency_key: input.idempotencyKey,
          provider_idempotency_key: input.providerIdempotencyKey,
          request_digest: input.requestDigest,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { value: created, replayed: false };
      const [existing] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.organization_id, input.organizationId),
            eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing || !exactCommandReplay(existing, input)) {
        conflict("Subscription command idempotency replay differs from the stored intent", {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        });
      }
      return { value: existing, replayed: true };
    });
  }

  /**
   * Commits the uncertainty fence before a caller performs provider I/O.
   * Once this returns, the provider idempotency key is the only safe retry
   * identity; this repository never claims that the remote outcome is known.
   */
  async markCommandOutcomeUnknown(input: {
    organizationId: string;
    commandId: string;
    expectedStateRevision: number;
    expectedExecutionGeneration: number;
  }): Promise<BillingSubscriptionCommand | null> {
    return writeTransaction(async (tx) => {
      const existing = await this.lockCommand(tx, input.organizationId, input.commandId);
      if (!existing) return null;
      if (
        existing.status === "OUTCOME_UNKNOWN" &&
        existing.state_revision === input.expectedStateRevision + 1 &&
        existing.execution_generation === input.expectedExecutionGeneration + 1
      )
        return existing;
      if (
        existing.status !== "PREPARED" ||
        existing.state_revision !== input.expectedStateRevision ||
        existing.execution_generation !== input.expectedExecutionGeneration
      )
        return null;
      const now = await readPostLockDatabaseNow(tx);
      const [updated] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "OUTCOME_UNKNOWN",
          state_revision: existing.state_revision + 1,
          execution_generation: existing.execution_generation + 1,
          attempt_count: existing.attempt_count + 1,
          provider_started_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(billingSubscriptionCommands.id, existing.id),
            eq(billingSubscriptionCommands.organization_id, existing.organization_id),
            eq(billingSubscriptionCommands.state_revision, existing.state_revision),
            eq(billingSubscriptionCommands.execution_generation, existing.execution_generation),
            eq(billingSubscriptionCommands.status, "PREPARED"),
          ),
        )
        .returning();
      return updated ?? null;
    });
  }

  async resolveCommandOutcome(input: {
    organizationId: string;
    commandId: string;
    expectedStateRevision: number;
    expectedExecutionGeneration: number;
    outcome: "SUCCEEDED" | "FAILED";
    providerResponseDigest: string | null;
    errorCode: string | null;
  }): Promise<BillingSubscriptionCommand | null> {
    if ((input.outcome === "SUCCEEDED") !== (input.providerResponseDigest !== null))
      invalid("Successful resolution requires a provider digest", "providerResponseDigest");
    if ((input.outcome === "FAILED") !== (input.errorCode !== null))
      invalid("Failed resolution requires an error code", "errorCode");
    return writeTransaction(async (tx) => {
      const existing = await this.lockCommand(tx, input.organizationId, input.commandId);
      if (!existing) return null;
      if (
        existing.status === input.outcome &&
        existing.state_revision === input.expectedStateRevision + 1 &&
        existing.execution_generation === input.expectedExecutionGeneration &&
        existing.provider_response_digest === input.providerResponseDigest &&
        existing.error_code === input.errorCode
      )
        return existing;
      if (
        existing.status !== "OUTCOME_UNKNOWN" ||
        existing.state_revision !== input.expectedStateRevision ||
        existing.execution_generation !== input.expectedExecutionGeneration
      )
        return null;
      const now = await readPostLockDatabaseNow(tx);
      const [updated] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: input.outcome,
          state_revision: existing.state_revision + 1,
          provider_response_digest: input.providerResponseDigest,
          error_code: input.errorCode,
          completed_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(billingSubscriptionCommands.id, existing.id),
            eq(billingSubscriptionCommands.organization_id, existing.organization_id),
            eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
            eq(billingSubscriptionCommands.state_revision, existing.state_revision),
            eq(billingSubscriptionCommands.execution_generation, existing.execution_generation),
          ),
        )
        .returning();
      return updated ?? null;
    });
  }

  /** Releases the checkout fence only after its resulting lifecycle row is durable. */
  async applyCheckoutResult(input: {
    organizationId: string;
    commandId: string;
    resultSubscriptionId: string;
    expectedStateRevision: number;
  }): Promise<BillingSubscriptionCommand | null> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
        .for("update");
      if (!organization) return null;
      const existing = await this.lockCommand(tx, input.organizationId, input.commandId);
      if (!existing) return null;
      if (
        existing.status === "APPLIED" &&
        existing.result_subscription_id === input.resultSubscriptionId &&
        existing.state_revision === input.expectedStateRevision + 1
      ) {
        return existing;
      }
      if (
        existing.kind !== "checkout" ||
        existing.status !== "SUCCEEDED" ||
        existing.state_revision !== input.expectedStateRevision ||
        existing.target_plan_key === null ||
        existing.provider_response_digest === null
      ) {
        return null;
      }
      const [subscription] = await tx
        .select({
          id: billingSubscriptions.id,
        })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.organization_id, input.organizationId),
            eq(billingSubscriptions.id, input.resultSubscriptionId),
          ),
        )
        .limit(1)
        .for("update");
      if (!subscription) return null;
      const [resultRevision] = await tx
        .select({ id: billingSubscriptionRevisions.id })
        .from(billingSubscriptionRevisions)
        .where(
          and(
            eq(billingSubscriptionRevisions.organization_id, input.organizationId),
            eq(billingSubscriptionRevisions.subscription_id, input.resultSubscriptionId),
            eq(billingSubscriptionRevisions.source, "checkout"),
            eq(billingSubscriptionRevisions.plan_key, existing.target_plan_key),
            eq(
              billingSubscriptionRevisions.provider_object_digest,
              existing.provider_response_digest,
            ),
          ),
        )
        .limit(1);
      if (!resultRevision) return null;
      const now = await readPostLockDatabaseNow(tx);
      const [updated] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "APPLIED",
          state_revision: existing.state_revision + 1,
          result_subscription_id: subscription.id,
          applied_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(billingSubscriptionCommands.id, existing.id),
            eq(billingSubscriptionCommands.organization_id, existing.organization_id),
            eq(billingSubscriptionCommands.status, "SUCCEEDED"),
            eq(billingSubscriptionCommands.state_revision, existing.state_revision),
          ),
        )
        .returning();
      return updated ?? null;
    });
  }

  async supersedePreparedCommand(input: {
    organizationId: string;
    commandId: string;
    expectedStateRevision: number;
    errorCode: string;
  }): Promise<BillingSubscriptionCommand | null> {
    return writeTransaction(async (tx) => {
      const existing = await this.lockCommand(tx, input.organizationId, input.commandId);
      if (!existing) return null;
      if (
        existing.status === "SUPERSEDED" &&
        existing.state_revision === input.expectedStateRevision + 1 &&
        existing.error_code === input.errorCode
      )
        return existing;
      if (existing.status !== "PREPARED" || existing.state_revision !== input.expectedStateRevision)
        return null;
      const now = await readPostLockDatabaseNow(tx);
      const [updated] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUPERSEDED",
          state_revision: existing.state_revision + 1,
          error_code: input.errorCode,
          completed_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(billingSubscriptionCommands.id, existing.id),
            eq(billingSubscriptionCommands.organization_id, existing.organization_id),
            eq(billingSubscriptionCommands.status, "PREPARED"),
            eq(billingSubscriptionCommands.state_revision, existing.state_revision),
          ),
        )
        .returning();
      return updated ?? null;
    });
  }

  private async lockCommand(
    tx: DbTransaction,
    organizationId: string,
    commandId: string,
  ): Promise<BillingSubscriptionCommand | undefined> {
    const [row] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, organizationId),
          eq(billingSubscriptionCommands.id, commandId),
        ),
      )
      .for("update")
      .limit(1);
    return row;
  }

  async listCommandsNeedingRecovery(limit: number): Promise<BillingSubscriptionCommand[]> {
    return dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"))
      .orderBy(asc(billingSubscriptionCommands.updated_at))
      .limit(limit);
  }

  async findEventReceipt(
    organizationId: string,
    receiptId: string,
  ): Promise<BillingSubscriptionEventReceipt | undefined> {
    const [row] = await dbWrite
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, organizationId),
          eq(billingSubscriptionEventReceipts.id, receiptId),
        ),
      )
      .limit(1);
    return row;
  }

  async recordEvent(
    input: RecordSubscriptionEventInput,
  ): Promise<RepositoryMutation<BillingSubscriptionEventReceipt>> {
    requireDate(input.now, "now");
    const [created] = await dbWrite
      .insert(billingSubscriptionEventReceipts)
      .values({
        id: input.id,
        organization_id: input.organizationId,
        subscription_id: input.subscriptionId,
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        provider_object_type: input.providerObjectType,
        provider_object_id: input.providerObjectId,
        livemode: input.livemode,
        event_created_at: input.eventCreatedAt,
        payload_digest: input.payloadDigest,
        received_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing({ target: billingSubscriptionEventReceipts.provider_event_id })
      .returning();
    if (created) return { value: created, replayed: false };
    const [existing] = await dbWrite
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(eq(billingSubscriptionEventReceipts.provider_event_id, input.providerEventId))
      .limit(1);
    if (!existing || !exactEventReplay(existing, input)) {
      conflict("Provider event replay differs from the stored receipt", {
        providerEventId: input.providerEventId,
      });
    }
    return { value: existing, replayed: true };
  }

  async claimEvent(input: {
    organizationId: string;
    receiptId: string;
    leaseToken: string;
    leaseDurationMs: number;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      invalid("leaseDurationMs must be a positive safe integer", "leaseDurationMs");
    }
    const databaseNow = sql`clock_timestamp()`;
    const leaseExpiresAt = sql`clock_timestamp() + (${input.leaseDurationMs} * interval '1 millisecond')`;
    const [claimed] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: "processing",
        lease_token: input.leaseToken,
        lease_expires_at: leaseExpiresAt,
        attempt_count: sql`${billingSubscriptionEventReceipts.attempt_count} + 1`,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          or(
            eq(billingSubscriptionEventReceipts.status, "received"),
            and(
              eq(billingSubscriptionEventReceipts.status, "processing"),
              lte(billingSubscriptionEventReceipts.lease_expires_at, databaseNow),
            ),
          ),
        ),
      )
      .returning();
    if (claimed) return claimed;
    const [replayed] = await dbWrite
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, databaseNow),
        ),
      )
      .limit(1);
    return replayed ?? null;
  }

  async applyEvent(input: {
    organizationId: string;
    receiptId: string;
    leaseToken: string;
    subscriptionRevision: number;
    disposition: string;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    const databaseNow = sql`clock_timestamp()`;
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: "applied",
        lease_token: null,
        lease_expires_at: null,
        applied_subscription_revision: input.subscriptionRevision,
        disposition: input.disposition,
        processed_at: databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, databaseNow),
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await this.findEventReceipt(input.organizationId, input.receiptId);
    return existing?.status === "applied" &&
      existing.applied_subscription_revision === input.subscriptionRevision &&
      existing.disposition === input.disposition
      ? existing
      : null;
  }

  async failEvent(input: {
    organizationId: string;
    receiptId: string;
    leaseToken: string;
    status: "failed" | "quarantined";
    errorCode: string;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    const databaseNow = sql`clock_timestamp()`;
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: input.status,
        lease_token: null,
        lease_expires_at: null,
        error_code: input.errorCode,
        processed_at: databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, databaseNow),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async ignoreEvent(input: {
    organizationId: string;
    receiptId: string;
    leaseToken: string;
    disposition: string;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    const databaseNow = sql`clock_timestamp()`;
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: "ignored",
        lease_token: null,
        lease_expires_at: null,
        disposition: input.disposition,
        processed_at: databaseNow,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, databaseNow),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async reconcileEvent(input: {
    organizationId: string;
    receiptId: string;
    outcome: "applied" | "ignored";
    subscriptionRevision: number | null;
    disposition: string;
    now: Date;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    requireDate(input.now, "now");
    if ((input.outcome === "applied") !== (input.subscriptionRevision !== null)) {
      invalid(
        "Only applied reconciliation may name a subscription revision",
        "subscriptionRevision",
      );
    }
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: input.outcome,
        applied_subscription_revision: input.subscriptionRevision,
        disposition: input.disposition,
        error_code: null,
        processed_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          inArray(billingSubscriptionEventReceipts.status, ["failed", "quarantined"]),
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await this.findEventReceipt(input.organizationId, input.receiptId);
    return existing?.status === input.outcome &&
      existing.applied_subscription_revision === input.subscriptionRevision &&
      existing.disposition === input.disposition
      ? existing
      : null;
  }

  async listStuckEvents(limit: number): Promise<BillingSubscriptionEventReceipt[]> {
    return dbWrite
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(
        or(
          and(
            eq(billingSubscriptionEventReceipts.status, "processing"),
            lte(billingSubscriptionEventReceipts.lease_expires_at, sql`clock_timestamp()`),
          ),
          eq(billingSubscriptionEventReceipts.status, "failed"),
        ),
      )
      .orderBy(asc(billingSubscriptionEventReceipts.updated_at))
      .limit(limit);
  }

  async openIncident(input: {
    id?: string;
    organizationId: string;
    subscriptionId: string;
    commandId: string | null;
    eventReceiptId: string | null;
    kind: BillingSubscriptionIncidentKind;
    severity: BillingSubscriptionIncidentSeverity;
    fingerprint: string;
    context: Record<string, unknown>;
    nextRetryAt: Date | null;
    now: Date;
  }): Promise<RepositoryMutation<BillingSubscriptionIncident>> {
    requireDate(input.now, "now");
    const [created] = await dbWrite
      .insert(billingSubscriptionIncidents)
      .values({
        id: input.id,
        organization_id: input.organizationId,
        subscription_id: input.subscriptionId,
        command_id: input.commandId,
        event_receipt_id: input.eventReceiptId,
        kind: input.kind,
        severity: input.severity,
        fingerprint: input.fingerprint,
        context: input.context,
        next_retry_at: input.nextRetryAt,
        first_observed_at: input.now,
        last_observed_at: input.now,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { value: created, replayed: false };
    const [existing] = await dbWrite
      .select()
      .from(billingSubscriptionIncidents)
      .where(
        and(
          eq(billingSubscriptionIncidents.organization_id, input.organizationId),
          eq(billingSubscriptionIncidents.subscription_id, input.subscriptionId),
          eq(billingSubscriptionIncidents.fingerprint, input.fingerprint),
          eq(billingSubscriptionIncidents.status, "open"),
        ),
      )
      .limit(1);
    if (
      !existing ||
      (input.id !== undefined && existing.id !== input.id) ||
      existing.kind !== input.kind ||
      existing.severity !== input.severity ||
      existing.command_id !== input.commandId ||
      existing.event_receipt_id !== input.eventReceiptId ||
      !sameDate(existing.next_retry_at, input.nextRetryAt) ||
      canonicalJson(existing.context) !== canonicalJson(input.context)
    ) {
      conflict("Incident fingerprint replay differs from the stored evidence", {
        organizationId: input.organizationId,
        fingerprint: input.fingerprint,
      });
    }
    const [observed] = await dbWrite
      .update(billingSubscriptionIncidents)
      .set({
        occurrence_count: sql`${billingSubscriptionIncidents.occurrence_count} + 1`,
        last_observed_at: input.now,
        next_retry_at: input.nextRetryAt,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionIncidents.organization_id, input.organizationId),
          eq(billingSubscriptionIncidents.id, existing.id),
          eq(billingSubscriptionIncidents.status, "open"),
        ),
      )
      .returning();
    if (!observed) {
      conflict("Incident changed while recording another occurrence", {
        organizationId: input.organizationId,
        fingerprint: input.fingerprint,
      });
    }
    return { value: observed, replayed: true };
  }

  async resolveIncident(input: {
    organizationId: string;
    incidentId: string;
    resolvedByUserId: string | null;
    resolution: string;
    now: Date;
  }): Promise<BillingSubscriptionIncident | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionIncidents)
      .set({
        status: "resolved",
        resolved_by_user_id: input.resolvedByUserId,
        resolution: input.resolution,
        resolved_at: input.now,
        next_retry_at: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionIncidents.organization_id, input.organizationId),
          eq(billingSubscriptionIncidents.id, input.incidentId),
          eq(billingSubscriptionIncidents.status, "open"),
        ),
      )
      .returning();
    if (updated) return updated;
    const [existing] = await dbWrite
      .select()
      .from(billingSubscriptionIncidents)
      .where(
        and(
          eq(billingSubscriptionIncidents.organization_id, input.organizationId),
          eq(billingSubscriptionIncidents.id, input.incidentId),
          eq(billingSubscriptionIncidents.status, "resolved"),
          input.resolvedByUserId === null
            ? isNull(billingSubscriptionIncidents.resolved_by_user_id)
            : eq(billingSubscriptionIncidents.resolved_by_user_id, input.resolvedByUserId),
          eq(billingSubscriptionIncidents.resolution, input.resolution),
        ),
      )
      .limit(1);
    return existing ?? null;
  }

  async listDueIncidents(now: Date, limit: number): Promise<BillingSubscriptionIncident[]> {
    requireDate(now, "now");
    return dbWrite
      .select()
      .from(billingSubscriptionIncidents)
      .where(
        and(
          eq(billingSubscriptionIncidents.status, "open"),
          lte(billingSubscriptionIncidents.next_retry_at, now),
        ),
      )
      .orderBy(asc(billingSubscriptionIncidents.next_retry_at))
      .limit(limit);
  }

  async findFence(
    organizationId: string,
    subscriptionId: string,
  ): Promise<SubscriptionBillingFence | undefined> {
    const [row] = await dbWrite
      .select()
      .from(subscriptionBillingFences)
      .where(
        and(
          eq(subscriptionBillingFences.organization_id, organizationId),
          eq(subscriptionBillingFences.subscription_id, subscriptionId),
        ),
      )
      .limit(1);
    return row;
  }

  async createFence(
    input: CreateSubscriptionFenceInput,
  ): Promise<RepositoryMutation<SubscriptionBillingFence>> {
    requireDate(input.now, "now");
    const [created] = await dbWrite
      .insert(subscriptionBillingFences)
      .values({
        id: input.id,
        organization_id: input.organizationId,
        subscription_id: input.subscriptionId,
        provider_event_id: input.providerEventId,
        provider_event_created_at: input.providerEventCreatedAt,
        provider_object_digest: input.providerObjectDigest,
        next_reconcile_at: input.nextReconcileAt,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { value: created, replayed: false };
    const existing = await this.findFence(input.organizationId, input.subscriptionId);
    if (
      !existing ||
      (input.id !== undefined && existing.id !== input.id) ||
      existing.state !== "open" ||
      existing.fence_revision !== 1 ||
      existing.provider_event_id !== input.providerEventId ||
      !sameDate(existing.provider_event_created_at, input.providerEventCreatedAt) ||
      existing.provider_object_digest !== input.providerObjectDigest ||
      !sameDate(existing.next_reconcile_at, input.nextReconcileAt)
    ) {
      conflict("Subscription deletion fence replay differs from stored authority", {
        organizationId: input.organizationId,
        subscriptionId: input.subscriptionId,
      });
    }
    return { value: existing, replayed: true };
  }

  async advanceFence(
    input: AdvanceSubscriptionFenceInput,
  ): Promise<RepositoryMutation<SubscriptionBillingFence> | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(subscriptionBillingFences)
      .set({
        state: input.state,
        fence_revision: input.expectedFenceRevision + 1,
        provider_event_id: input.providerEventId,
        provider_event_created_at: input.providerEventCreatedAt,
        provider_object_digest: input.providerObjectDigest,
        deletion_requested_at: input.deletionRequestedAt,
        provider_deleted_at: input.providerDeletedAt,
        released_at: input.releasedAt,
        last_reconciled_at: input.lastReconciledAt,
        next_reconcile_at: input.nextReconcileAt,
        updated_at: input.now,
      })
      .where(
        and(
          eq(subscriptionBillingFences.organization_id, input.organizationId),
          eq(subscriptionBillingFences.subscription_id, input.subscriptionId),
          eq(subscriptionBillingFences.fence_revision, input.expectedFenceRevision),
        ),
      )
      .returning();
    if (updated) return { value: updated, replayed: false };
    const existing = await this.findFence(input.organizationId, input.subscriptionId);
    return existing && exactFence(existing, input) ? { value: existing, replayed: true } : null;
  }

  async listDueFences(now: Date, limit: number): Promise<SubscriptionBillingFence[]> {
    requireDate(now, "now");
    return dbWrite
      .select()
      .from(subscriptionBillingFences)
      .where(
        and(
          inArray(subscriptionBillingFences.state, [
            "open",
            "deletion_requested",
            "provider_deleted",
            "quarantined",
          ]),
          lte(subscriptionBillingFences.next_reconcile_at, now),
        ),
      )
      .orderBy(asc(subscriptionBillingFences.next_reconcile_at))
      .limit(limit);
  }
}

export const subscriptionBillingOperationsRepository =
  new SubscriptionBillingOperationsRepository();
