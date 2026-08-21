/**
 * Owns durable subscription command, webhook receipt, incident, and deletion-fence transitions.
 * Provider calls remain outside this module; every mutation is an exact database CAS or replay.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { dbWrite } from "../helpers";
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

export const SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT = "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT";
export const SUBSCRIPTION_BILLING_OPERATIONS_INVALID = "SUBSCRIPTION_BILLING_OPERATIONS_INVALID";

export interface RepositoryMutation<T> {
  value: T;
  replayed: boolean;
}

export interface EnqueueSubscriptionCommandInput {
  id?: string;
  organizationId: string;
  subscriptionId: string;
  requestedByUserId: string;
  kind: BillingSubscriptionCommandKind;
  targetPlanKey: "plus_monthly" | "pro_monthly" | null;
  expectedSubscriptionRevision: number;
  idempotencyKey: string;
  stripeIdempotencyKey: string;
  requestDigest: string;
  now: Date;
}

export interface RecordSubscriptionEventInput {
  id?: string;
  organizationId: string;
  subscriptionId: string;
  stripeEventId: string;
  eventType: string;
  stripeObjectType: "subscription" | "invoice";
  stripeObjectId: string;
  livemode: boolean;
  eventCreatedAt: Date;
  payloadDigest: string;
  now: Date;
}

export interface CreateSubscriptionFenceInput {
  id?: string;
  organizationId: string;
  subscriptionId: string;
  providerObjectVersion: number;
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
  providerObjectVersion: number;
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

function requireLease(now: Date, expiresAt: Date): void {
  requireDate(now, "now");
  requireDate(expiresAt, "leaseExpiresAt");
  if (expiresAt.getTime() <= now.getTime())
    invalid("leaseExpiresAt must be after now", "leaseExpiresAt");
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
    row.stripe_idempotency_key === input.stripeIdempotencyKey &&
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
    row.stripe_event_id === input.stripeEventId &&
    row.event_type === input.eventType &&
    row.stripe_object_type === input.stripeObjectType &&
    row.stripe_object_id === input.stripeObjectId &&
    row.livemode === input.livemode &&
    sameDate(row.event_created_at, input.eventCreatedAt) &&
    row.payload_digest === input.payloadDigest
  );
}

function exactFence(row: SubscriptionBillingFence, input: AdvanceSubscriptionFenceInput): boolean {
  return (
    row.fence_revision === input.expectedFenceRevision + 1 &&
    row.state === input.state &&
    row.provider_object_version === input.providerObjectVersion &&
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
    const [created] = await dbWrite
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
        stripe_idempotency_key: input.stripeIdempotencyKey,
        request_digest: input.requestDigest,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { value: created, replayed: false };
    const [existing] = await dbWrite
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
  }

  async claimCommand(input: {
    organizationId: string;
    commandId: string;
    leaseToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<BillingSubscriptionCommand | null> {
    requireLease(input.now, input.leaseExpiresAt);
    const [claimed] = await dbWrite
      .update(billingSubscriptionCommands)
      .set({
        status: "processing",
        lease_token: input.leaseToken,
        lease_expires_at: input.leaseExpiresAt,
        attempt_count: sql`${billingSubscriptionCommands.attempt_count} + 1`,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          isNull(billingSubscriptionCommands.provider_started_at),
          or(
            eq(billingSubscriptionCommands.status, "queued"),
            and(
              eq(billingSubscriptionCommands.status, "processing"),
              lte(billingSubscriptionCommands.lease_expires_at, input.now),
            ),
          ),
        ),
      )
      .returning();
    if (claimed) return claimed;
    const [replayed] = await dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.status, "processing"),
          eq(billingSubscriptionCommands.lease_token, input.leaseToken),
          gt(billingSubscriptionCommands.lease_expires_at, input.now),
        ),
      )
      .limit(1);
    return replayed ?? null;
  }

  async markCommandProviderStarted(input: {
    organizationId: string;
    commandId: string;
    leaseToken: string;
    now: Date;
  }): Promise<BillingSubscriptionCommand | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionCommands)
      .set({ provider_started_at: input.now, updated_at: input.now })
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.status, "processing"),
          eq(billingSubscriptionCommands.lease_token, input.leaseToken),
          gt(billingSubscriptionCommands.lease_expires_at, input.now),
          isNull(billingSubscriptionCommands.provider_started_at),
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await this.findCommand(input.organizationId, input.commandId);
    return existing?.status === "processing" &&
      existing.lease_token === input.leaseToken &&
      existing.provider_started_at &&
      existing.lease_expires_at &&
      existing.lease_expires_at.getTime() > input.now.getTime()
      ? existing
      : null;
  }

  async markCommandAmbiguous(input: {
    organizationId: string;
    commandId: string;
    leaseToken: string;
    errorCode: string;
    now: Date;
  }): Promise<BillingSubscriptionCommand | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionCommands)
      .set({
        status: "provider_ambiguous",
        lease_token: null,
        lease_expires_at: null,
        error_code: input.errorCode,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.status, "processing"),
          eq(billingSubscriptionCommands.lease_token, input.leaseToken),
          sql`${billingSubscriptionCommands.provider_started_at} IS NOT NULL`,
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await this.findCommand(input.organizationId, input.commandId);
    return existing?.status === "provider_ambiguous" && existing.error_code === input.errorCode
      ? existing
      : null;
  }

  async completeCommand(input: {
    organizationId: string;
    commandId: string;
    leaseToken: string;
    providerResponseDigest: string;
    now: Date;
  }): Promise<BillingSubscriptionCommand | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionCommands)
      .set({
        status: "succeeded",
        lease_token: null,
        lease_expires_at: null,
        provider_response_digest: input.providerResponseDigest,
        completed_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.status, "processing"),
          eq(billingSubscriptionCommands.lease_token, input.leaseToken),
          gt(billingSubscriptionCommands.lease_expires_at, input.now),
          sql`${billingSubscriptionCommands.provider_started_at} IS NOT NULL`,
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await this.findCommand(input.organizationId, input.commandId);
    return existing?.status === "succeeded" &&
      existing.provider_response_digest === input.providerResponseDigest
      ? existing
      : null;
  }

  async reconcileAmbiguousCommand(input: {
    organizationId: string;
    commandId: string;
    outcome: "succeeded" | "failed";
    providerResponseDigest: string | null;
    errorCode: string | null;
    now: Date;
  }): Promise<BillingSubscriptionCommand | null> {
    requireDate(input.now, "now");
    if ((input.outcome === "succeeded") !== (input.providerResponseDigest !== null)) {
      invalid(
        "Successful reconciliation requires exactly one provider digest",
        "providerResponseDigest",
      );
    }
    if ((input.outcome === "failed") !== (input.errorCode !== null)) {
      invalid("Failed reconciliation requires exactly one error code", "errorCode");
    }
    const [updated] = await dbWrite
      .update(billingSubscriptionCommands)
      .set({
        status: input.outcome,
        provider_response_digest: input.providerResponseDigest,
        error_code: input.errorCode,
        completed_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.status, "provider_ambiguous"),
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await this.findCommand(input.organizationId, input.commandId);
    return existing?.status === input.outcome &&
      existing.provider_response_digest === input.providerResponseDigest &&
      existing.error_code === input.errorCode
      ? existing
      : null;
  }

  async listStuckCommands(now: Date, limit: number): Promise<BillingSubscriptionCommand[]> {
    requireDate(now, "now");
    return dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        or(
          and(
            eq(billingSubscriptionCommands.status, "processing"),
            lte(billingSubscriptionCommands.lease_expires_at, now),
          ),
          eq(billingSubscriptionCommands.status, "provider_ambiguous"),
        ),
      )
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
        stripe_event_id: input.stripeEventId,
        event_type: input.eventType,
        stripe_object_type: input.stripeObjectType,
        stripe_object_id: input.stripeObjectId,
        livemode: input.livemode,
        event_created_at: input.eventCreatedAt,
        payload_digest: input.payloadDigest,
        received_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing({ target: billingSubscriptionEventReceipts.stripe_event_id })
      .returning();
    if (created) return { value: created, replayed: false };
    const [existing] = await dbWrite
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(eq(billingSubscriptionEventReceipts.stripe_event_id, input.stripeEventId))
      .limit(1);
    if (!existing || !exactEventReplay(existing, input)) {
      conflict("Stripe event replay differs from the stored receipt", {
        stripeEventId: input.stripeEventId,
      });
    }
    return { value: existing, replayed: true };
  }

  async claimEvent(input: {
    organizationId: string;
    receiptId: string;
    leaseToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    requireLease(input.now, input.leaseExpiresAt);
    const [claimed] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: "processing",
        lease_token: input.leaseToken,
        lease_expires_at: input.leaseExpiresAt,
        attempt_count: sql`${billingSubscriptionEventReceipts.attempt_count} + 1`,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          or(
            eq(billingSubscriptionEventReceipts.status, "received"),
            and(
              eq(billingSubscriptionEventReceipts.status, "processing"),
              lte(billingSubscriptionEventReceipts.lease_expires_at, input.now),
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
          gt(billingSubscriptionEventReceipts.lease_expires_at, input.now),
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
    now: Date;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: "applied",
        lease_token: null,
        lease_expires_at: null,
        applied_subscription_revision: input.subscriptionRevision,
        disposition: input.disposition,
        processed_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, input.now),
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
    now: Date;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: input.status,
        lease_token: null,
        lease_expires_at: null,
        error_code: input.errorCode,
        processed_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, input.now),
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
    now: Date;
  }): Promise<BillingSubscriptionEventReceipt | null> {
    requireDate(input.now, "now");
    const [updated] = await dbWrite
      .update(billingSubscriptionEventReceipts)
      .set({
        status: "ignored",
        lease_token: null,
        lease_expires_at: null,
        disposition: input.disposition,
        processed_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
          eq(billingSubscriptionEventReceipts.status, "processing"),
          eq(billingSubscriptionEventReceipts.lease_token, input.leaseToken),
          gt(billingSubscriptionEventReceipts.lease_expires_at, input.now),
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

  async listStuckEvents(now: Date, limit: number): Promise<BillingSubscriptionEventReceipt[]> {
    requireDate(now, "now");
    return dbWrite
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(
        or(
          and(
            eq(billingSubscriptionEventReceipts.status, "processing"),
            lte(billingSubscriptionEventReceipts.lease_expires_at, now),
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
        provider_object_version: input.providerObjectVersion,
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
      existing.provider_object_version !== input.providerObjectVersion ||
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
        provider_object_version: input.providerObjectVersion,
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
          lte(subscriptionBillingFences.provider_object_version, input.providerObjectVersion),
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
