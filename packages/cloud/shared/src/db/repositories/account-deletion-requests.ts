/** Persists durable deletion receipts and generation-fenced worker state transitions. */

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AccountDeletionExport,
  accountDeletionExports,
} from "../schemas/account-deletion-exports";
import {
  type AccountDeletionPhaseReceipt,
  accountDeletionPhaseReceipts,
} from "../schemas/account-deletion-phase-receipts";
import {
  type AccountDeletionRequest,
  accountDeletionRequests,
  type NewAccountDeletionRequest,
} from "../schemas/account-deletion-requests";
import { apiKeys } from "../schemas/api-keys";
import { organizations } from "../schemas/organizations";
import { userSessions } from "../schemas/user-sessions";
import { users } from "../schemas/users";

const TERMINAL_REQUEST_STATUSES = ["completed", "canceled"] as const;

export interface ReservePersonalAccountDeletionInput {
  requestId: string;
  userId: string;
  organizationId: string;
  stewardUserId: string;
  now: Date;
  recoveryExpiresAt: Date;
  statusTokenHash: string;
  statusTokenExpiresAt: Date;
  recoveryTokenHash: string;
  recoveryTokenExpiresAt: Date;
  requestDigest: string;
  phases: ReadonlyArray<{
    phase: string;
    phaseOrder: number;
    idempotencyKeyDigest: string;
    completed?: boolean;
  }>;
}

export type ReservePersonalAccountDeletionResult =
  | { outcome: "reserved"; request: AccountDeletionRequest }
  | { outcome: "existing"; request: AccountDeletionRequest }
  | { outcome: "account_unavailable" }
  | { outcome: "anonymous_account" }
  | { outcome: "transfer_required"; activeOwnerCount: number };

export interface AccountDeletionPhaseLease {
  receipt: AccountDeletionPhaseReceipt;
  generation: number;
}

export interface AccountDeletionStatusRecord {
  request: AccountDeletionRequest;
  exportReceipt: AccountDeletionExport | null;
}

export type CancelAccountDeletionResult =
  | {
      outcome: "canceled";
      request: AccountDeletionRequest;
      stewardUserId: string;
    }
  | { outcome: "already_canceled"; request: AccountDeletionRequest }
  | { outcome: "invalid_credential" }
  | { outcome: "recovery_expired" };

export class AccountDeletionRequestsRepository {
  async findOpenByUserId(
    userId: string,
    readFromPrimary = false,
  ): Promise<AccountDeletionRequest | undefined> {
    const database = readFromPrimary ? dbWrite : dbRead;
    const [request] = await database
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.user_id, userId),
          notInArray(accountDeletionRequests.status, [
            ...TERMINAL_REQUEST_STATUSES,
          ]),
        ),
      )
      .limit(1);
    return request;
  }

  /**
   * Reserves deletion and publishes every immediate local fence under one
   * organization/user lock. No provider call occurs inside this transaction.
   */
  async reservePersonalAccountDeletion(
    input: ReservePersonalAccountDeletionInput,
  ): Promise<ReservePersonalAccountDeletionResult> {
    return await dbWrite.transaction(async (tx) => {
      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update")
        .limit(1);
      if (!organization) return { outcome: "account_unavailable" };

      const members = await tx
        .select()
        .from(users)
        .where(eq(users.organization_id, input.organizationId))
        .for("update");
      const current = members.find((member) => member.id === input.userId);

      const [existing] = await tx
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.user_id, input.userId),
            notInArray(accountDeletionRequests.status, [
              ...TERMINAL_REQUEST_STATUSES,
            ]),
          ),
        )
        .for("update")
        .limit(1);
      if (existing) {
        const [rotated] = await tx
          .update(accountDeletionRequests)
          .set({
            status_token_hash: input.statusTokenHash,
            status_token_expires_at: input.statusTokenExpiresAt,
            recovery_token_hash: input.recoveryTokenHash,
            recovery_token_expires_at: input.recoveryTokenExpiresAt,
            updated_at: input.now,
          })
          .where(eq(accountDeletionRequests.id, existing.id))
          .returning();
        if (!rotated)
          throw new Error(
            "Open account deletion receipt disappeared while locked",
          );
        return { outcome: "existing", request: rotated };
      }

      if (!current || !current.is_active || current.deleted_at) {
        return { outcome: "account_unavailable" };
      }
      if (current.is_anonymous) return { outcome: "anonymous_account" };

      const activeMembers = members.filter(
        (member) => member.is_active && !member.deleted_at,
      );
      const activeOwners = activeMembers.filter(
        (member) => member.role === "owner",
      );
      if (activeMembers.length !== 1) {
        return {
          outcome: "transfer_required",
          activeOwnerCount: activeOwners.length,
        };
      }

      const [request] = await tx
        .insert(accountDeletionRequests)
        .values({
          id: input.requestId,
          user_id: input.userId,
          organization_id: input.organizationId,
          steward_user_id: input.stewardUserId,
          operation_kind: "personal_account_deletion",
          status: "reserved",
          lifecycle_revision:
            Math.max(
              current.account_lifecycle_revision,
              organization.account_lifecycle_revision,
            ) + 1,
          status_token_hash: input.statusTokenHash,
          status_token_expires_at: input.statusTokenExpiresAt,
          recovery_token_hash: input.recoveryTokenHash,
          recovery_token_expires_at: input.recoveryTokenExpiresAt,
          request_digest: input.requestDigest,
          restore_auto_top_up_enabled:
            organization.auto_top_up_enabled ?? false,
          restore_pay_as_you_go_from_earnings:
            organization.pay_as_you_go_from_earnings,
          requested_at: input.now,
          recovery_expires_at: input.recoveryExpiresAt,
          execute_after: input.recoveryExpiresAt,
          updated_at: input.now,
        })
        .returning();
      if (!request) throw new Error("Account deletion receipt was not created");

      await tx
        .update(users)
        .set({
          account_lifecycle_state: "deletion_recovery",
          account_lifecycle_revision: request.lifecycle_revision,
          account_deletion_request_id: request.id,
          auth_fenced_at: input.now,
          is_active: false,
          updated_at: input.now,
        })
        .where(eq(users.id, input.userId));
      await tx
        .update(organizations)
        .set({
          account_lifecycle_state: "deletion_recovery",
          account_lifecycle_revision: request.lifecycle_revision,
          account_deletion_request_id: request.id,
          paid_work_fenced_at: input.now,
          auto_top_up_enabled: false,
          pay_as_you_go_from_earnings: false,
          is_active: false,
          updated_at: input.now,
        })
        .where(eq(organizations.id, input.organizationId));
      await tx
        .update(apiKeys)
        .set({ is_active: false, updated_at: input.now })
        .where(
          and(
            eq(apiKeys.user_id, input.userId),
            eq(apiKeys.organization_id, input.organizationId),
          ),
        );
      await tx
        .update(userSessions)
        .set({ ended_at: input.now, updated_at: input.now })
        .where(
          and(
            eq(userSessions.user_id, input.userId),
            isNull(userSessions.ended_at),
          ),
        );

      await tx.insert(accountDeletionPhaseReceipts).values(
        input.phases.map((phase) => ({
          request_id: request.id,
          phase: phase.phase,
          phase_order: phase.phaseOrder,
          status: phase.completed ? "completed" : "pending",
          idempotency_key_digest: phase.idempotencyKeyDigest,
          completed_at: phase.completed ? input.now : null,
          created_at: input.now,
          updated_at: input.now,
        })),
      );
      await tx.insert(accountDeletionExports).values({
        request_id: request.id,
        status: "pending",
        expires_at: input.recoveryExpiresAt,
        created_at: input.now,
        updated_at: input.now,
      });

      return { outcome: "reserved", request };
    });
  }

  async leasePhase(input: {
    requestId: string;
    phase: string;
    leaseOwnerDigest: string;
    now: Date;
    leaseMilliseconds: number;
  }): Promise<AccountDeletionPhaseLease | undefined> {
    return await dbWrite.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(accountDeletionPhaseReceipts)
        .where(
          and(
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            eq(accountDeletionPhaseReceipts.phase, input.phase),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !current ||
        current.status === "completed" ||
        current.status === "action_required"
      ) {
        return undefined;
      }
      if (current.lease_expires_at && current.lease_expires_at > input.now)
        return undefined;
      if (current.next_attempt_at && current.next_attempt_at > input.now)
        return undefined;

      const generation = current.lease_generation + 1;
      const [leased] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: current.status === "calling" ? "reconciling" : "leased",
          lease_generation: generation,
          lease_owner_digest: input.leaseOwnerDigest,
          lease_expires_at: new Date(
            input.now.getTime() + input.leaseMilliseconds,
          ),
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, current.id),
            eq(
              accountDeletionPhaseReceipts.lease_generation,
              current.lease_generation,
            ),
          ),
        )
        .returning();
      return leased ? { receipt: leased, generation } : undefined;
    });
  }

  async markPhaseProviderCallStarted(
    phaseReceiptId: string,
    generation: number,
    now: Date,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionPhaseReceipts)
      .set({
        status: "calling",
        before_provider_call_at: now,
        attempt_count: sql`${accountDeletionPhaseReceipts.attempt_count} + 1`,
        updated_at: now,
      })
      .where(
        and(
          eq(accountDeletionPhaseReceipts.id, phaseReceiptId),
          eq(accountDeletionPhaseReceipts.status, "leased"),
          eq(accountDeletionPhaseReceipts.lease_generation, generation),
        ),
      )
      .returning({ id: accountDeletionPhaseReceipts.id });
    return updated !== undefined;
  }

  async completeStewardDeactivationPhase(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    providerReceiptDigest: string;
    now: Date;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [completed] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: "completed",
          provider_receipt_digest: input.providerReceiptDigest,
          provider_acknowledged_at: input.now,
          reconciled_at: input.now,
          completed_at: input.now,
          lease_owner_digest: null,
          lease_expires_at: null,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            eq(accountDeletionPhaseReceipts.status, "calling"),
            eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
          ),
        )
        .returning({ id: accountDeletionPhaseReceipts.id });
      if (!completed) return false;

      const [request] = await tx
        .update(accountDeletionRequests)
        .set({ identity_deactivated_at: input.now, updated_at: input.now })
        .where(eq(accountDeletionRequests.id, input.requestId))
        .returning({ id: accountDeletionRequests.id });
      if (!request)
        throw new Error(
          "Deletion request disappeared after Steward deactivation",
        );
      return true;
    });
  }

  async completeStewardReactivationPhase(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    providerReceiptDigest: string;
    now: Date;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [completed] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: "completed",
          provider_receipt_digest: input.providerReceiptDigest,
          provider_acknowledged_at: input.now,
          reconciled_at: input.now,
          completed_at: input.now,
          lease_owner_digest: null,
          lease_expires_at: null,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            eq(accountDeletionPhaseReceipts.status, "calling"),
            eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
          ),
        )
        .returning({ id: accountDeletionPhaseReceipts.id });
      if (!completed) return false;
      const [request] = await tx
        .update(accountDeletionRequests)
        .set({
          identity_deactivated_at: null,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionRequests.id, input.requestId),
            eq(accountDeletionRequests.status, "canceled"),
          ),
        )
        .returning({ id: accountDeletionRequests.id });
      if (!request)
        throw new Error(
          "Canceled deletion receipt disappeared during reactivation",
        );
      return true;
    });
  }

  async markPhaseForReconciliation(input: {
    phaseReceiptId: string;
    generation: number;
    errorCode: string;
    now: Date;
    retryAt: Date;
  }): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionPhaseReceipts)
      .set({
        status: "reconciling",
        retry_class: "ambiguous_provider_outcome",
        next_attempt_at: input.retryAt,
        lease_owner_digest: null,
        lease_expires_at: null,
        last_error_code: input.errorCode,
        updated_at: input.now,
      })
      .where(
        and(
          eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
          eq(accountDeletionPhaseReceipts.status, "calling"),
          eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
        ),
      )
      .returning({ id: accountDeletionPhaseReceipts.id });
    return updated !== undefined;
  }

  async cancelDuringRecovery(input: {
    recoveryTokenHash: string;
    reactivationIdempotencyKeyDigest: string;
    now: Date;
  }): Promise<CancelAccountDeletionResult> {
    const [observed] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(
        eq(
          accountDeletionRequests.recovery_token_hash,
          input.recoveryTokenHash,
        ),
      )
      .limit(1);
    if (!observed) return { outcome: "invalid_credential" };
    if (observed.status === "canceled")
      return { outcome: "already_canceled", request: observed };
    if (
      !observed.user_id ||
      !observed.organization_id ||
      !observed.steward_user_id ||
      !observed.recovery_expires_at ||
      observed.recovery_expires_at <= input.now ||
      (observed.status !== "reserved" && observed.status !== "recovery")
    ) {
      return { outcome: "recovery_expired" };
    }

    return await dbWrite.transaction(async (tx) => {
      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, observed.organization_id!))
        .for("update")
        .limit(1);
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, observed.user_id!))
        .for("update")
        .limit(1);
      const [request] = await tx
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, observed.id))
        .for("update")
        .limit(1);
      if (!organization || !user || !request)
        return { outcome: "recovery_expired" };
      if (request.status === "canceled")
        return { outcome: "already_canceled", request };
      if (
        request.recovery_token_hash !== input.recoveryTokenHash ||
        !request.recovery_expires_at ||
        request.recovery_expires_at <= input.now ||
        (request.status !== "reserved" && request.status !== "recovery")
      ) {
        return { outcome: "recovery_expired" };
      }

      const restoredRevision = request.lifecycle_revision + 1;
      await tx
        .update(organizations)
        .set({
          account_lifecycle_state: "active",
          account_lifecycle_revision: restoredRevision,
          account_deletion_request_id: null,
          paid_work_fenced_at: null,
          auto_top_up_enabled: request.restore_auto_top_up_enabled ?? false,
          pay_as_you_go_from_earnings:
            request.restore_pay_as_you_go_from_earnings ?? false,
          is_active: true,
          updated_at: input.now,
        })
        .where(eq(organizations.id, organization.id));
      await tx
        .update(users)
        .set({
          account_lifecycle_state: "active",
          account_lifecycle_revision: restoredRevision,
          account_deletion_request_id: null,
          auth_fenced_at: null,
          is_active: true,
          updated_at: input.now,
        })
        .where(eq(users.id, user.id));
      await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: "canceled",
          lease_owner_digest: null,
          lease_expires_at: null,
          next_attempt_at: null,
          completed_at: input.now,
          last_error_code: "DELETION_CANCELED_DURING_RECOVERY",
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.request_id, request.id),
            notInArray(accountDeletionPhaseReceipts.status, [
              "completed",
              "canceled",
            ]),
          ),
        );
      await tx
        .insert(accountDeletionPhaseReceipts)
        .values({
          request_id: request.id,
          phase: "steward_reactivation",
          phase_order: 15,
          status: "pending",
          idempotency_key_digest: input.reactivationIdempotencyKeyDigest,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflictDoNothing();
      await tx
        .update(accountDeletionExports)
        .set({ status: "expired", updated_at: input.now })
        .where(eq(accountDeletionExports.request_id, request.id));

      const [canceled] = await tx
        .update(accountDeletionRequests)
        .set({
          status: "canceled",
          canceled_at: input.now,
          recovery_token_hash: null,
          recovery_token_expires_at: null,
          last_error_code: "STEWARD_REACTIVATION_PENDING",
          updated_at: input.now,
        })
        .where(eq(accountDeletionRequests.id, request.id))
        .returning();
      if (!canceled)
        throw new Error(
          "Deletion receipt disappeared during recovery cancellation",
        );
      return {
        outcome: "canceled",
        request: canceled,
        stewardUserId: request.steward_user_id!,
      };
    });
  }

  async findById(id: string): Promise<AccountDeletionRequest | undefined> {
    const [request] = await dbRead
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, id))
      .limit(1);
    return request;
  }

  /** Primary-only lookup for the read-only post-session status capability. */
  async findByStatusTokenHash(
    statusTokenHash: string,
    now = new Date(),
  ): Promise<AccountDeletionStatusRecord | undefined> {
    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.status_token_hash, statusTokenHash),
          gt(accountDeletionRequests.status_token_expires_at, now),
        ),
      )
      .limit(1);
    if (!request) return undefined;
    const [exportReceipt] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, request.id))
      .limit(1);
    return { request, exportReceipt: exportReceipt ?? null };
  }

  async createIdempotent(
    data: NewAccountDeletionRequest,
  ): Promise<AccountDeletionRequest> {
    const [created] = await dbWrite
      .insert(accountDeletionRequests)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    if (!data.user_id) {
      throw new Error("Account deletion request requires a user ID");
    }
    const existing = await this.findOpenByUserId(data.user_id, true);
    if (!existing) {
      throw new Error(
        "Account deletion request conflicted but no open request was found",
      );
    }
    return existing;
  }

  async update(
    id: string,
    data: Partial<NewAccountDeletionRequest>,
  ): Promise<AccountDeletionRequest | undefined> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({ ...data, updated_at: new Date() })
      .where(eq(accountDeletionRequests.id, id))
      .returning();
    return updated;
  }

  async claimDue(
    limit: number,
    now = new Date(),
  ): Promise<AccountDeletionRequest[]> {
    return await dbWrite.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.status, "scheduled"),
            lte(accountDeletionRequests.execute_after, now),
          ),
        )
        .orderBy(asc(accountDeletionRequests.execute_after))
        .for("update", { skipLocked: true })
        .limit(limit);
      if (due.length === 0) return [];
      const claimedAt = now;
      return await tx
        .update(accountDeletionRequests)
        .set({
          status: "processing",
          processing_started_at: claimedAt,
          updated_at: claimedAt,
        })
        .where(
          inArray(
            accountDeletionRequests.id,
            due.map((request) => request.id),
          ),
        )
        .returning();
    });
  }

  async recoverStaleProcessing(startedBefore: Date): Promise<number> {
    const recovered = await dbWrite
      .update(accountDeletionRequests)
      .set({
        status: "scheduled",
        processing_started_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(accountDeletionRequests.status, "processing"),
          lt(accountDeletionRequests.processing_started_at, startedBefore),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    return recovered.length;
  }

  /** Parks only the exact worker generation that still owns the processing claim. */
  async markActionRequired(
    id: string,
    processingStartedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({
        status: "action_required",
        processing_started_at: null,
        last_error_code: errorCode,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(accountDeletionRequests.id, id),
          eq(accountDeletionRequests.status, "processing"),
          eq(
            accountDeletionRequests.processing_started_at,
            processingStartedAt,
          ),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    return updated !== undefined;
  }

  async recordPurgeFailure(
    id: string,
    processingStartedAt: Date,
    errorCode: string,
  ): Promise<AccountDeletionRequest | undefined> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({
        attempts: sql`${accountDeletionRequests.attempts} + 1`,
        status: sql`CASE WHEN ${accountDeletionRequests.attempts} + 1 >= ${accountDeletionRequests.max_attempts} THEN 'action_required' ELSE 'scheduled' END`,
        execute_after: new Date(Date.now() + 60 * 60 * 1_000),
        processing_started_at: null,
        last_error_code: errorCode,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(accountDeletionRequests.id, id),
          eq(accountDeletionRequests.status, "processing"),
          eq(
            accountDeletionRequests.processing_started_at,
            processingStartedAt,
          ),
        ),
      )
      .returning();
    return updated;
  }
}

export const accountDeletionRequestsRepository =
  new AccountDeletionRequestsRepository();
