/** Persists durable deletion receipts and generation-fenced worker state transitions. */

import { ElizaError } from "@elizaos/core/edge";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
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
import { agentSandboxReplacementAttempts } from "../schemas/agent-sandbox-replacement-attempts";
import { apiKeys } from "../schemas/api-keys";
import { organizations } from "../schemas/organizations";
import { providerAdmissions } from "../schemas/provider-admissions";
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
  admissionTokenHash: string;
  admissionTokenExpiresAt: Date;
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
  | { outcome: "replayed"; request: AccountDeletionRequest }
  | { outcome: "existing"; request: AccountDeletionRequest }
  | { outcome: "account_unavailable" }
  | { outcome: "anonymous_account" }
  | { outcome: "transfer_required"; activeOwnerCount: number };

export type ActivateReservedAccountDeletionResult =
  | { outcome: "activated"; request: AccountDeletionRequest }
  | { outcome: "already_activated"; request: AccountDeletionRequest }
  | { outcome: "invalid_credential" }
  | { outcome: "account_unavailable" }
  | { outcome: "provider_work_in_flight" }
  | { outcome: "transfer_required"; activeOwnerCount: number };

export interface AccountDeletionPhaseLease {
  receipt: AccountDeletionPhaseReceipt;
  generation: number;
}

export interface AccountDeletionStatusRecord {
  request: AccountDeletionRequest;
  exportReceipt: AccountDeletionExport | null;
}

export type ActivateExpiredAccountDeletionResult =
  | { outcome: "activated"; request: AccountDeletionRequest }
  | { outcome: "already_activated"; request: AccountDeletionRequest }
  | { outcome: "not_due" }
  | { outcome: "account_unavailable" }
  | { outcome: "transfer_required"; activeOwnerCount: number }
  | { outcome: "export_required" }
  | { outcome: "identity_deactivation_required" }
  | { outcome: "provider_work_in_flight" };

export type FinalizePersonalAccountDeletionResult =
  | { outcome: "completed"; request: AccountDeletionRequest }
  | { outcome: "already_completed"; request: AccountDeletionRequest }
  | { outcome: "stale_generation" }
  | { outcome: "account_unavailable" }
  | { outcome: "transfer_required"; activeOwnerCount: number }
  | { outcome: "phases_incomplete"; phases: string[] };

export type CancelAccountDeletionResult =
  | {
      outcome: "canceling";
      request: AccountDeletionRequest;
      stewardUserId: string;
    }
  | { outcome: "already_canceling"; request: AccountDeletionRequest }
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
          notInArray(accountDeletionRequests.status, [...TERMINAL_REQUEST_STATUSES]),
        ),
      )
      .limit(1);
    return request;
  }

  async findOpenByUserAndOrganizationId(
    userId: string,
    organizationId: string,
    readFromPrimary = false,
  ): Promise<AccountDeletionRequest | undefined> {
    const database = readFromPrimary ? dbWrite : dbRead;
    const [request] = await database
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.user_id, userId),
          eq(accountDeletionRequests.organization_id, organizationId),
          notInArray(accountDeletionRequests.status, [...TERMINAL_REQUEST_STATUSES]),
        ),
      )
      .limit(1);
    return request;
  }

  /** Reserves the recovery package without fencing local or provider authority. */
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
            eq(accountDeletionRequests.organization_id, input.organizationId),
            notInArray(accountDeletionRequests.status, [...TERMINAL_REQUEST_STATUSES]),
          ),
        )
        .for("update")
        .limit(1);
      if (existing) {
        // The first committed receipt owns both opaque capabilities. Rotating
        // them on a concurrent replay can invalidate credentials already
        // returned to the winner and can orphan an export encrypted to the
        // original recovery credential.
        if (existing.admission_token_hash === input.admissionTokenHash) {
          return { outcome: "replayed", request: existing };
        }
        if (existing.status !== "requested") {
          return { outcome: "existing", request: existing };
        }

        // A pre-fence package may be replaced by the same recently
        // authenticated account after browser eviction. The receipt identity,
        // provider idempotency keys, and provider-free state remain unchanged;
        // the superseded bearer hashes can no longer activate it.
        const [replaced] = await tx
          .update(accountDeletionRequests)
          .set({
            status_token_hash: input.statusTokenHash,
            status_token_expires_at: input.statusTokenExpiresAt,
            recovery_token_hash: input.recoveryTokenHash,
            recovery_token_expires_at: input.recoveryTokenExpiresAt,
            admission_token_hash: input.admissionTokenHash,
            admission_token_expires_at: input.admissionTokenExpiresAt,
            requested_at: input.now,
            recovery_expires_at: input.recoveryExpiresAt,
            execute_after: input.recoveryExpiresAt,
            updated_at: input.now,
          })
          .where(eq(accountDeletionRequests.id, existing.id))
          .returning();
        if (!replaced) {
          throw new ElizaError("Account deletion reservation replacement was not committed", {
            code: "ACCOUNT_DELETION_RESERVATION_REPLACEMENT_MISSING",
            severity: "fatal",
          });
        }
        await tx
          .update(accountDeletionExports)
          .set({ expires_at: input.recoveryExpiresAt, updated_at: input.now })
          .where(eq(accountDeletionExports.request_id, existing.id));
        return { outcome: "reserved", request: replaced };
      }

      if (!current || !current.is_active || current.deleted_at) {
        return { outcome: "account_unavailable" };
      }
      if (current.is_anonymous) return { outcome: "anonymous_account" };

      const activeMembers = members.filter((member) => member.is_active && !member.deleted_at);
      const activeOwners = activeMembers.filter((member) => member.role === "owner");
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
          status: "requested",
          lifecycle_revision:
            Math.max(current.account_lifecycle_revision, organization.account_lifecycle_revision) +
            1,
          status_token_hash: input.statusTokenHash,
          status_token_expires_at: input.statusTokenExpiresAt,
          recovery_token_hash: input.recoveryTokenHash,
          recovery_token_expires_at: input.recoveryTokenExpiresAt,
          admission_token_hash: input.admissionTokenHash,
          admission_token_expires_at: input.admissionTokenExpiresAt,
          request_digest: input.requestDigest,
          restore_auto_top_up_enabled: organization.auto_top_up_enabled ?? false,
          restore_pay_as_you_go_from_earnings: organization.pay_as_you_go_from_earnings,
          requested_at: input.now,
          recovery_expires_at: input.recoveryExpiresAt,
          execute_after: input.recoveryExpiresAt,
          updated_at: input.now,
        })
        .returning();
      if (!request) {
        throw new ElizaError("Account deletion receipt was not created", {
          code: "ACCOUNT_DELETION_RESERVATION_MISSING",
          severity: "fatal",
        });
      }

      await tx.insert(accountDeletionPhaseReceipts).values(
        input.phases.map((phase) => ({
          request_id: request.id,
          phase: phase.phase,
          phase_order: phase.phaseOrder,
          status: "pending",
          idempotency_key_digest: phase.idempotencyKeyDigest,
          completed_at: null,
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

  /**
   * Publishes all immediate local fences only after the browser proves it
   * retained the recovery package. Replays observe the same authority revision
   * and cannot revoke a second session/key epoch.
   */
  async activateReservedPersonalAccountDeletion(input: {
    recoveryTokenHash: string;
    now: Date;
  }): Promise<ActivateReservedAccountDeletionResult> {
    const [observed] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.recovery_token_hash, input.recoveryTokenHash))
      .limit(1);
    if (!observed) return { outcome: "invalid_credential" };
    if (observed.status !== "requested") {
      return { outcome: "already_activated", request: observed };
    }
    if (!observed.user_id || !observed.organization_id) {
      return { outcome: "account_unavailable" };
    }

    return await dbWrite.transaction(async (tx) => {
      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, observed.organization_id!))
        .for("update")
        .limit(1);
      const members = await tx
        .select()
        .from(users)
        .where(eq(users.organization_id, observed.organization_id!))
        .for("update");
      const [request] = await tx
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, observed.id))
        .for("update")
        .limit(1);
      if (!request || request.recovery_token_hash !== input.recoveryTokenHash) {
        return { outcome: "invalid_credential" };
      }
      if (request.status !== "requested") {
        return { outcome: "already_activated", request };
      }
      if (!request.recovery_token_expires_at || request.recovery_token_expires_at <= input.now) {
        return { outcome: "invalid_credential" };
      }
      const current = members.find((member) => member.id === request.user_id);
      if (!organization || !current || !current.is_active || current.deleted_at) {
        return { outcome: "account_unavailable" };
      }
      const [providerAdmission] = await tx
        .select({ id: providerAdmissions.id })
        .from(providerAdmissions)
        .where(
          and(
            eq(providerAdmissions.organization_id, organization.id),
            isNull(providerAdmissions.released_at),
          ),
        )
        .limit(1);
      if (providerAdmission) return { outcome: "provider_work_in_flight" };
      const activeMembers = members.filter((member) => member.is_active && !member.deleted_at);
      const activeOwners = activeMembers.filter((member) => member.role === "owner");
      if (activeMembers.length !== 1) {
        return { outcome: "transfer_required", activeOwnerCount: activeOwners.length };
      }

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
        .where(eq(users.id, current.id));
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
        .where(eq(organizations.id, organization.id));
      await tx
        .update(apiKeys)
        .set({ is_active: false, updated_at: input.now })
        .where(and(eq(apiKeys.user_id, current.id), eq(apiKeys.organization_id, organization.id)));
      await tx
        .update(userSessions)
        .set({ ended_at: input.now, updated_at: input.now })
        .where(and(eq(userSessions.user_id, current.id), isNull(userSessions.ended_at)));
      await tx
        .update(accountDeletionPhaseReceipts)
        .set({ status: "completed", completed_at: input.now, updated_at: input.now })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.request_id, request.id),
            eq(accountDeletionPhaseReceipts.phase, "account_authority"),
            eq(accountDeletionPhaseReceipts.status, "pending"),
          ),
        );
      const [activated] = await tx
        .update(accountDeletionRequests)
        .set({ status: "reserved", updated_at: input.now })
        .where(
          and(
            eq(accountDeletionRequests.id, request.id),
            eq(accountDeletionRequests.status, "requested"),
          ),
        )
        .returning();
      if (!activated) {
        throw new ElizaError("Account deletion activation was not committed", {
          code: "ACCOUNT_DELETION_ACTIVATION_MISSING",
          severity: "fatal",
        });
      }
      return { outcome: "activated", request: activated };
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
        current.status === "canceled" ||
        current.status === "action_required"
      ) {
        return undefined;
      }
      if (current.attempt_count >= current.max_attempts) {
        await tx
          .update(accountDeletionPhaseReceipts)
          .set({
            status: "action_required",
            retry_class: "attempts_exhausted",
            lease_owner_digest: null,
            lease_expires_at: null,
            next_attempt_at: null,
            last_error_code: "ACCOUNT_DELETION_PHASE_ATTEMPTS_EXHAUSTED",
            updated_at: input.now,
          })
          .where(eq(accountDeletionPhaseReceipts.id, current.id));
        return undefined;
      }
      if (current.lease_expires_at && current.lease_expires_at > input.now) return undefined;
      if (current.next_attempt_at && current.next_attempt_at > input.now) return undefined;

      const generation = current.lease_generation + 1;
      const [leased] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status:
            current.status === "calling" || current.status === "reconciling"
              ? "reconciling"
              : "leased",
          lease_generation: generation,
          lease_owner_digest: input.leaseOwnerDigest,
          lease_expires_at: new Date(input.now.getTime() + input.leaseMilliseconds),
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, current.id),
            eq(accountDeletionPhaseReceipts.lease_generation, current.lease_generation),
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
    providerOperationDigest?: string,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionPhaseReceipts)
      .set({
        status: "calling",
        before_provider_call_at: now,
        provider_operation_digest: providerOperationDigest,
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

  /**
   * Publishes the irreversible authority only after the recovery export and
   * immediate identity fence are durably acknowledged. Organization, member,
   * request, and phase rows share one transaction and lock order.
   */
  async activateExpiredPersonalAccountDeletion(input: {
    requestId: string;
    exportRevocationIdempotencyKeyDigest: string;
    exportRevocationNotBefore: Date;
    now: Date;
  }): Promise<ActivateExpiredAccountDeletionResult> {
    return await dbWrite.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, input.requestId))
        .for("update")
        .limit(1);
      if (!request) return { outcome: "account_unavailable" };
      if (request.status === "scheduled" || request.status === "processing") {
        return { outcome: "already_activated", request };
      }
      if (
        (request.status !== "reserved" && request.status !== "recovery") ||
        request.execute_after > input.now
      ) {
        return { outcome: "not_due" };
      }
      if (!request.user_id || !request.organization_id) {
        return { outcome: "account_unavailable" };
      }

      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, request.organization_id))
        .for("update")
        .limit(1);
      const members = await tx
        .select()
        .from(users)
        .where(eq(users.organization_id, request.organization_id))
        .for("update");
      const current = members.find((member) => member.id === request.user_id);
      if (!organization || !current) return { outcome: "account_unavailable" };

      const [providerAdmission] = await tx
        .select({ id: providerAdmissions.id })
        .from(providerAdmissions)
        .where(
          and(
            eq(providerAdmissions.organization_id, organization.id),
            isNull(providerAdmissions.released_at),
          ),
        )
        .limit(1);
      if (providerAdmission) return { outcome: "provider_work_in_flight" };

      const activeOwners = members.filter(
        (member) => member.is_active && !member.deleted_at && member.role === "owner",
      );
      if (members.length !== 1) {
        return {
          outcome: "transfer_required",
          activeOwnerCount: activeOwners.length,
        };
      }
      if (
        organization.account_deletion_request_id !== request.id ||
        current.account_deletion_request_id !== request.id ||
        organization.account_lifecycle_revision !== request.lifecycle_revision ||
        current.account_lifecycle_revision !== request.lifecycle_revision
      ) {
        return { outcome: "account_unavailable" };
      }

      const [exportReceipt] = await tx
        .select()
        .from(accountDeletionExports)
        .where(eq(accountDeletionExports.request_id, request.id))
        .for("update")
        .limit(1);
      const phases = await tx
        .select()
        .from(accountDeletionPhaseReceipts)
        .where(eq(accountDeletionPhaseReceipts.request_id, request.id))
        .for("update");
      if (
        exportReceipt?.status !== "ready" ||
        phases.find((phase) => phase.phase === "export")?.status !== "completed"
      ) {
        return { outcome: "export_required" };
      }
      if (
        request.identity_deactivated_at === null ||
        phases.find((phase) => phase.phase === "steward_deactivation")?.status !== "completed"
      ) {
        return { outcome: "identity_deactivation_required" };
      }

      const lifecycleRevision = request.lifecycle_revision + 1;
      await tx
        .update(organizations)
        .set({
          account_lifecycle_state: "deletion_irreversible",
          account_lifecycle_revision: lifecycleRevision,
          paid_work_fenced_at: organization.paid_work_fenced_at ?? input.now,
          auto_top_up_enabled: false,
          pay_as_you_go_from_earnings: false,
          is_active: false,
          updated_at: input.now,
        })
        .where(eq(organizations.id, organization.id));
      await tx
        .update(users)
        .set({
          account_lifecycle_state: "deletion_irreversible",
          account_lifecycle_revision: lifecycleRevision,
          auth_fenced_at: current.auth_fenced_at ?? input.now,
          is_active: false,
          updated_at: input.now,
        })
        .where(eq(users.id, current.id));
      await tx
        .update(accountDeletionExports)
        .set({ status: "expired", updated_at: input.now })
        .where(eq(accountDeletionExports.request_id, request.id));
      await tx
        .insert(accountDeletionPhaseReceipts)
        .values({
          request_id: request.id,
          phase: "export_revoke",
          phase_order: 3,
          status: "pending",
          idempotency_key_digest: input.exportRevocationIdempotencyKeyDigest,
          next_attempt_at: input.exportRevocationNotBefore,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflictDoNothing();

      const [activated] = await tx
        .update(accountDeletionRequests)
        .set({
          status: "scheduled",
          lifecycle_revision: lifecycleRevision,
          recovery_token_hash: null,
          recovery_token_expires_at: null,
          admission_token_hash: null,
          admission_token_expires_at: null,
          irreversible_at: input.now,
          last_error_code: null,
          failure_class: null,
          next_reconcile_at: input.now,
          updated_at: input.now,
        })
        .where(eq(accountDeletionRequests.id, request.id))
        .returning();
      if (!activated) {
        throw new ElizaError("Deletion receipt disappeared during irreversible activation", {
          code: "ACCOUNT_DELETION_IRREVERSIBLE_ACTIVATION_MISSING",
          severity: "fatal",
        });
      }
      return { outcome: "activated", request: activated };
    });
  }

  async findExpiredRecoveryRequestIds(now: Date, limit: number): Promise<string[]> {
    const rows = await dbWrite
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(
        and(
          inArray(accountDeletionRequests.status, ["reserved", "recovery"]),
          lte(accountDeletionRequests.execute_after, now),
        ),
      )
      .orderBy(asc(accountDeletionRequests.execute_after))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async findRecoveryPhaseCandidates(
    phase: string,
    now: Date,
    limit: number,
  ): Promise<AccountDeletionRequest[]> {
    return await dbWrite
      .select({ request: accountDeletionRequests })
      .from(accountDeletionPhaseReceipts)
      .innerJoin(
        accountDeletionRequests,
        eq(accountDeletionRequests.id, accountDeletionPhaseReceipts.request_id),
      )
      .where(
        and(
          eq(accountDeletionPhaseReceipts.phase, phase),
          inArray(accountDeletionRequests.status, ["reserved", "recovery"]),
          notInArray(accountDeletionPhaseReceipts.status, [
            "completed",
            "canceled",
            "action_required",
          ]),
          or(
            isNull(accountDeletionPhaseReceipts.next_attempt_at),
            lte(accountDeletionPhaseReceipts.next_attempt_at, now),
          ),
          or(
            isNull(accountDeletionPhaseReceipts.lease_expires_at),
            lte(accountDeletionPhaseReceipts.lease_expires_at, now),
          ),
        ),
      )
      .orderBy(asc(accountDeletionPhaseReceipts.created_at))
      .limit(limit)
      .then((rows) => rows.map((row) => row.request));
  }

  async findCancellationPhaseCandidates(
    phase: "steward_reactivation",
    now: Date,
    limit: number,
  ): Promise<AccountDeletionRequest[]> {
    return await dbWrite
      .select({ request: accountDeletionRequests })
      .from(accountDeletionPhaseReceipts)
      .innerJoin(
        accountDeletionRequests,
        eq(accountDeletionRequests.id, accountDeletionPhaseReceipts.request_id),
      )
      .where(
        and(
          eq(accountDeletionPhaseReceipts.phase, phase),
          eq(accountDeletionRequests.status, "canceling"),
          notInArray(accountDeletionPhaseReceipts.status, [
            "completed",
            "canceled",
            "action_required",
          ]),
          or(
            isNull(accountDeletionPhaseReceipts.next_attempt_at),
            lte(accountDeletionPhaseReceipts.next_attempt_at, now),
          ),
          or(
            isNull(accountDeletionPhaseReceipts.lease_expires_at),
            lte(accountDeletionPhaseReceipts.lease_expires_at, now),
          ),
        ),
      )
      .orderBy(asc(accountDeletionPhaseReceipts.created_at))
      .limit(limit)
      .then((rows) => rows.map((row) => row.request));
  }

  async markRecoveryActionRequired(input: {
    requestId: string;
    errorCode: string;
    now: Date;
  }): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionRequests)
      .set({
        status: "action_required",
        recovery_token_hash: null,
        recovery_token_expires_at: null,
        admission_token_hash: null,
        admission_token_expires_at: null,
        last_error_code: input.errorCode,
        failure_class: "operator_action_required",
        next_reconcile_at: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(accountDeletionRequests.id, input.requestId),
          inArray(accountDeletionRequests.status, ["reserved", "recovery"]),
        ),
      )
      .returning({ id: accountDeletionRequests.id });
    return updated !== undefined;
  }

  async findRunnableIrreversibleRequests(
    now: Date,
    limit: number,
  ): Promise<AccountDeletionRequest[]> {
    return await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          inArray(accountDeletionRequests.status, ["scheduled", "processing"]),
          lte(accountDeletionRequests.execute_after, now),
          or(
            isNull(accountDeletionRequests.next_reconcile_at),
            lte(accountDeletionRequests.next_reconcile_at, now),
          ),
        ),
      )
      .orderBy(asc(accountDeletionRequests.execute_after))
      .limit(limit);
  }

  async listPhaseReceipts(requestId: string): Promise<AccountDeletionPhaseReceipt[]> {
    return await dbWrite
      .select()
      .from(accountDeletionPhaseReceipts)
      .where(eq(accountDeletionPhaseReceipts.request_id, requestId))
      .orderBy(asc(accountDeletionPhaseReceipts.phase_order));
  }

  async completeProviderPhase(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    providerReceiptDigest: string;
    now: Date;
  }): Promise<boolean> {
    const [completed] = await dbWrite
      .update(accountDeletionPhaseReceipts)
      .set({
        status: "completed",
        provider_receipt_digest: input.providerReceiptDigest,
        provider_acknowledged_at: input.now,
        reconciled_at: input.now,
        completed_at: input.now,
        retry_class: null,
        next_attempt_at: null,
        lease_owner_digest: null,
        lease_expires_at: null,
        last_error_code: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
          eq(accountDeletionPhaseReceipts.request_id, input.requestId),
          inArray(accountDeletionPhaseReceipts.status, ["leased", "calling", "reconciling"]),
          eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
        ),
      )
      .returning({ id: accountDeletionPhaseReceipts.id });
    return completed !== undefined;
  }

  async markPhaseActionRequired(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    errorCode: string;
    now: Date;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [phase] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: "action_required",
          retry_class: "operator_action_required",
          next_attempt_at: null,
          lease_owner_digest: null,
          lease_expires_at: null,
          last_error_code: input.errorCode,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            inArray(accountDeletionPhaseReceipts.status, ["leased", "calling", "reconciling"]),
            eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
          ),
        )
        .returning({ id: accountDeletionPhaseReceipts.id });
      if (!phase) return false;
      await tx
        .update(accountDeletionRequests)
        .set({
          status: "action_required",
          processing_started_at: null,
          last_error_code: input.errorCode,
          failure_class: "operator_action_required",
          next_reconcile_at: null,
          updated_at: input.now,
        })
        .where(eq(accountDeletionRequests.id, input.requestId));
      return true;
    });
  }

  async scheduleRequestReconciliation(input: {
    requestId: string;
    now: Date;
    retryAt: Date;
    errorCode: string;
  }): Promise<void> {
    await dbWrite
      .update(accountDeletionRequests)
      .set({
        status: "processing",
        next_reconcile_at: input.retryAt,
        last_error_code: input.errorCode,
        failure_class: "retryable",
        updated_at: input.now,
      })
      .where(
        and(
          eq(accountDeletionRequests.id, input.requestId),
          inArray(accountDeletionRequests.status, ["scheduled", "processing"]),
        ),
      );
  }

  /**
   * Erases the sole-user organization and commits the bounded anonymous
   * receipt in the same transaction. Any incomplete phase or restrictive FK
   * aborts before identifiers are nulled.
   */
  async finalizePersonalAccountDeletion(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    completionReceiptDigest: string;
    now: Date;
  }): Promise<FinalizePersonalAccountDeletionResult> {
    return await dbWrite.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, input.requestId))
        .for("update")
        .limit(1);
      if (!request) return { outcome: "account_unavailable" };
      if (request.status === "completed") return { outcome: "already_completed", request };
      if (!request.user_id || !request.organization_id) {
        return { outcome: "account_unavailable" };
      }

      const [databasePhase] = await tx
        .select()
        .from(accountDeletionPhaseReceipts)
        .where(eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId))
        .for("update")
        .limit(1);
      if (
        !databasePhase ||
        databasePhase.request_id !== request.id ||
        databasePhase.phase !== "database_erasure" ||
        databasePhase.lease_generation !== input.generation ||
        (databasePhase.status !== "leased" && databasePhase.status !== "calling")
      ) {
        return { outcome: "stale_generation" };
      }

      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, request.organization_id))
        .for("update")
        .limit(1);
      const members = await tx
        .select()
        .from(users)
        .where(eq(users.organization_id, request.organization_id))
        .for("update");
      const current = members.find((member) => member.id === request.user_id);
      if (!organization || !current) return { outcome: "account_unavailable" };
      const activeOwners = members.filter(
        (member) => member.is_active && !member.deleted_at && member.role === "owner",
      );
      if (members.length !== 1) {
        return { outcome: "transfer_required", activeOwnerCount: activeOwners.length };
      }
      if (
        request.irreversible_at === null ||
        organization.account_lifecycle_state !== "deletion_irreversible" ||
        current.account_lifecycle_state !== "deletion_irreversible" ||
        organization.account_deletion_request_id !== request.id ||
        current.account_deletion_request_id !== request.id ||
        organization.account_lifecycle_revision !== request.lifecycle_revision ||
        current.account_lifecycle_revision !== request.lifecycle_revision
      ) {
        return { outcome: "account_unavailable" };
      }

      const phases = await tx
        .select()
        .from(accountDeletionPhaseReceipts)
        .where(eq(accountDeletionPhaseReceipts.request_id, request.id))
        .for("update");
      const incomplete = phases
        .filter(
          (phase) =>
            phase.phase !== "database_erasure" &&
            phase.status !== "completed" &&
            phase.status !== "canceled",
        )
        .map((phase) => phase.phase)
        .sort();
      if (incomplete.length > 0) return { outcome: "phases_incomplete", phases: incomplete };

      // Replacement attempts may contain provider locators, so they remain
      // restrictive until the compute phase proves every ambiguous effect is
      // reconciled. At terminal database erasure the bounded request receipt,
      // not the tenant-linked attempt row, becomes the retained evidence.
      await tx
        .delete(agentSandboxReplacementAttempts)
        .where(eq(agentSandboxReplacementAttempts.organization_id, organization.id));

      const deleted = await tx
        .delete(organizations)
        .where(eq(organizations.id, organization.id))
        .returning({ id: organizations.id });
      if (deleted.length !== 1) return { outcome: "account_unavailable" };

      await tx
        .delete(accountDeletionPhaseReceipts)
        .where(eq(accountDeletionPhaseReceipts.request_id, request.id));
      await tx
        .delete(accountDeletionExports)
        .where(eq(accountDeletionExports.request_id, request.id));
      const [completed] = await tx
        .update(accountDeletionRequests)
        .set({
          status: "completed",
          user_id: null,
          organization_id: null,
          steward_user_id: null,
          recovery_token_hash: null,
          recovery_token_expires_at: null,
          admission_token_hash: null,
          admission_token_expires_at: null,
          restore_auto_top_up_enabled: null,
          restore_pay_as_you_go_from_earnings: null,
          lease_expires_at: null,
          processing_started_at: null,
          completed_at: input.now,
          completion_receipt_digest: input.completionReceiptDigest,
          last_error_code: null,
          failure_class: null,
          next_reconcile_at: null,
          updated_at: input.now,
        })
        .where(eq(accountDeletionRequests.id, request.id))
        .returning();
      if (!completed) {
        throw new ElizaError("Deletion receipt disappeared during terminal completion", {
          code: "ACCOUNT_DELETION_TERMINAL_COMPLETION_MISSING",
          severity: "fatal",
        });
      }
      return { outcome: "completed", request: completed };
    });
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
            inArray(accountDeletionPhaseReceipts.status, ["leased", "calling", "reconciling"]),
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
      if (!request) {
        throw new ElizaError("Deletion request disappeared after Steward deactivation", {
          code: "ACCOUNT_DELETION_STEWARD_DEACTIVATION_REQUEST_MISSING",
          severity: "fatal",
        });
      }
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
            inArray(accountDeletionPhaseReceipts.status, ["leased", "calling", "reconciling"]),
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
            eq(accountDeletionRequests.status, "canceling"),
          ),
        )
        .returning({ id: accountDeletionRequests.id });
      if (!request) {
        throw new ElizaError("Canceled deletion receipt disappeared during reactivation", {
          code: "ACCOUNT_DELETION_STEWARD_REACTIVATION_REQUEST_MISSING",
          severity: "fatal",
        });
      }
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

  async markPhaseRetryable(input: {
    phaseReceiptId: string;
    generation: number;
    errorCode: string;
    retryClass: "definite_pre_provider_failure" | "provider_absence_confirmed";
    now: Date;
    retryAt: Date;
  }): Promise<boolean> {
    const [updated] = await dbWrite
      .update(accountDeletionPhaseReceipts)
      .set({
        status: "retry",
        retry_class: input.retryClass,
        next_attempt_at: input.retryAt,
        lease_owner_digest: null,
        lease_expires_at: null,
        last_error_code: input.errorCode,
        updated_at: input.now,
      })
      .where(
        and(
          eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
          inArray(accountDeletionPhaseReceipts.status, ["leased", "reconciling"]),
          eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
        ),
      )
      .returning({ id: accountDeletionPhaseReceipts.id });
    return updated !== undefined;
  }

  async deferPhaseReconciliation(input: {
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
          eq(accountDeletionPhaseReceipts.status, "reconciling"),
          eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
        ),
      )
      .returning({ id: accountDeletionPhaseReceipts.id });
    return updated !== undefined;
  }

  async markExportBuilding(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    now: Date;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [phase] = await tx
        .select({ id: accountDeletionPhaseReceipts.id })
        .from(accountDeletionPhaseReceipts)
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            eq(accountDeletionPhaseReceipts.status, "leased"),
            eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
          ),
        )
        .for("update")
        .limit(1);
      if (!phase) return false;
      const [updated] = await tx
        .update(accountDeletionExports)
        .set({ status: "building", last_error_code: null, updated_at: input.now })
        .where(eq(accountDeletionExports.request_id, input.requestId))
        .returning({ id: accountDeletionExports.id });
      return updated !== undefined;
    });
  }

  async completeExportPhase(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    contentDigest: string;
    objectReceiptDigest: string;
    byteCount: number;
    now: Date;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [completed] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: "completed",
          provider_receipt_digest: input.objectReceiptDigest,
          provider_acknowledged_at: input.now,
          reconciled_at: input.now,
          completed_at: input.now,
          lease_owner_digest: null,
          lease_expires_at: null,
          next_attempt_at: null,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            inArray(accountDeletionPhaseReceipts.status, ["calling", "reconciling"]),
            eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
          ),
        )
        .returning({ id: accountDeletionPhaseReceipts.id });
      if (!completed) return false;

      const [exportReceipt] = await tx
        .update(accountDeletionExports)
        .set({
          status: "ready",
          content_digest: input.contentDigest,
          object_receipt_digest: input.objectReceiptDigest,
          byte_count: input.byteCount,
          ready_at: input.now,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(eq(accountDeletionExports.request_id, input.requestId))
        .returning({ id: accountDeletionExports.id });
      if (!exportReceipt) {
        throw new ElizaError("Deletion export receipt disappeared during completion", {
          code: "ACCOUNT_DELETION_EXPORT_COMPLETION_RECEIPT_MISSING",
          severity: "fatal",
        });
      }

      const [request] = await tx
        .update(accountDeletionRequests)
        .set({ status: "recovery", updated_at: input.now })
        .where(
          and(
            eq(accountDeletionRequests.id, input.requestId),
            inArray(accountDeletionRequests.status, ["reserved", "recovery"]),
          ),
        )
        .returning({ id: accountDeletionRequests.id });
      if (!request) {
        throw new ElizaError("Deletion request cannot enter recovery after export", {
          code: "ACCOUNT_DELETION_EXPORT_RECOVERY_TRANSITION_MISSING",
          severity: "fatal",
        });
      }
      return true;
    });
  }

  async cancelDuringRecovery(input: {
    recoveryTokenHash: string;
    reactivationIdempotencyKeyDigest: string;
    exportRevocationIdempotencyKeyDigest: string;
    exportRevocationNotBefore: Date;
    now: Date;
  }): Promise<CancelAccountDeletionResult> {
    const [observed] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.recovery_token_hash, input.recoveryTokenHash))
      .limit(1);
    if (!observed) return { outcome: "invalid_credential" };
    if (observed.status === "canceled") return { outcome: "already_canceled", request: observed };
    if (observed.status === "canceling") return { outcome: "already_canceling", request: observed };
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
      if (!organization || !user || !request) return { outcome: "recovery_expired" };
      if (request.status === "canceled") return { outcome: "already_canceled", request };
      if (request.status === "canceling") return { outcome: "already_canceling", request };
      if (
        request.recovery_token_hash !== input.recoveryTokenHash ||
        !request.recovery_expires_at ||
        request.recovery_expires_at <= input.now ||
        (request.status !== "reserved" && request.status !== "recovery")
      ) {
        return { outcome: "recovery_expired" };
      }

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
            notInArray(accountDeletionPhaseReceipts.status, ["completed", "canceled"]),
          ),
        );
      await tx
        .insert(accountDeletionPhaseReceipts)
        .values({
          request_id: request.id,
          phase: "steward_reactivation",
          phase_order: 1_000,
          status: "pending",
          idempotency_key_digest: input.reactivationIdempotencyKeyDigest,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflictDoNothing();
      await tx
        .insert(accountDeletionPhaseReceipts)
        .values({
          request_id: request.id,
          phase: "export_revoke",
          phase_order: 1_010,
          status: "pending",
          idempotency_key_digest: input.exportRevocationIdempotencyKeyDigest,
          next_attempt_at: input.exportRevocationNotBefore,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflictDoNothing();
      await tx
        .update(accountDeletionExports)
        .set({ status: "expired", updated_at: input.now })
        .where(eq(accountDeletionExports.request_id, request.id));

      const [canceling] = await tx
        .update(accountDeletionRequests)
        .set({
          status: "canceling",
          canceled_at: input.now,
          admission_token_hash: null,
          admission_token_expires_at: null,
          last_error_code: "STEWARD_REACTIVATION_PENDING",
          updated_at: input.now,
        })
        .where(eq(accountDeletionRequests.id, request.id))
        .returning();
      if (!canceling) {
        throw new ElizaError("Deletion receipt disappeared during recovery cancellation", {
          code: "ACCOUNT_DELETION_CANCELLATION_RECEIPT_MISSING",
          severity: "fatal",
        });
      }
      return {
        outcome: "canceling",
        request: canceling,
        stewardUserId: request.steward_user_id!,
      };
    });
  }

  async findCancelingRequestIds(limit: number): Promise<string[]> {
    const rows = await dbWrite
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.status, "canceling"))
      .orderBy(asc(accountDeletionRequests.updated_at))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Restores account authority only after both cancellation cleanup receipts complete. */
  async finalizeCancellationIfComplete(input: { requestId: string; now: Date }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, input.requestId))
        .for("update")
        .limit(1);
      if (!request || request.status === "canceled") return request?.status === "canceled";
      if (request.status !== "canceling" || !request.user_id || !request.organization_id) {
        return false;
      }
      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, request.organization_id))
        .for("update")
        .limit(1);
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, request.user_id))
        .for("update")
        .limit(1);
      if (!organization || !user) return false;
      const cleanup = await tx
        .select()
        .from(accountDeletionPhaseReceipts)
        .where(
          and(
            eq(accountDeletionPhaseReceipts.request_id, request.id),
            inArray(accountDeletionPhaseReceipts.phase, ["steward_reactivation", "export_revoke"]),
          ),
        )
        .for("update");
      if (cleanup.length !== 2 || cleanup.some((phase) => phase.status !== "completed")) {
        return false;
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
          pay_as_you_go_from_earnings: request.restore_pay_as_you_go_from_earnings ?? false,
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
      const [completed] = await tx
        .update(accountDeletionRequests)
        .set({
          status: "canceled",
          lifecycle_revision: restoredRevision,
          recovery_token_hash: null,
          recovery_token_expires_at: null,
          admission_token_hash: null,
          admission_token_expires_at: null,
          identity_deactivated_at: null,
          last_error_code: null,
          failure_class: null,
          next_reconcile_at: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionRequests.id, request.id),
            eq(accountDeletionRequests.status, "canceling"),
          ),
        )
        .returning({ id: accountDeletionRequests.id });
      return completed !== undefined;
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

  /** Primary-only lookup for response-loss recovery of the first receipt capabilities. */
  async findByAdmissionTokenHash(
    admissionTokenHash: string,
    now = new Date(),
  ): Promise<AccountDeletionStatusRecord | undefined> {
    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.admission_token_hash, admissionTokenHash),
          gt(accountDeletionRequests.admission_token_expires_at, now),
          isNotNull(accountDeletionRequests.status_token_hash),
          isNotNull(accountDeletionRequests.recovery_token_hash),
          inArray(accountDeletionRequests.status, ["reserved", "recovery"]),
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

  /** Primary-only recovery capability lookup for export and undo authority. */
  async findByRecoveryTokenHash(
    recoveryTokenHash: string,
  ): Promise<AccountDeletionStatusRecord | undefined> {
    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.recovery_token_hash, recoveryTokenHash))
      .limit(1);
    if (!request) return undefined;
    const [exportReceipt] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, request.id))
      .limit(1);
    return { request, exportReceipt: exportReceipt ?? null };
  }

  async findExpiredExportCandidates(
    now: Date,
    limit: number,
  ): Promise<Array<{ requestId: string; requestDigest: string }>> {
    const rows = await dbWrite
      .select({
        requestId: accountDeletionRequests.id,
        requestDigest: accountDeletionRequests.request_digest,
      })
      .from(accountDeletionExports)
      .innerJoin(
        accountDeletionRequests,
        eq(accountDeletionRequests.id, accountDeletionExports.request_id),
      )
      .where(
        and(
          lte(accountDeletionExports.expires_at, now),
          inArray(accountDeletionExports.status, ["pending", "building", "ready", "failed"]),
        ),
      )
      .orderBy(asc(accountDeletionExports.expires_at))
      .limit(limit);
    return rows.flatMap((row) =>
      row.requestDigest ? [{ requestId: row.requestId, requestDigest: row.requestDigest }] : [],
    );
  }

  async ensureExportRevocationPhase(input: {
    requestId: string;
    idempotencyKeyDigest: string;
    nextAttemptAt: Date;
    now: Date;
  }): Promise<void> {
    await dbWrite.transaction(async (tx) => {
      await tx
        .update(accountDeletionExports)
        .set({ status: "expired", updated_at: input.now })
        .where(
          and(
            eq(accountDeletionExports.request_id, input.requestId),
            notInArray(accountDeletionExports.status, ["deleted"]),
          ),
        );
      await tx
        .insert(accountDeletionPhaseReceipts)
        .values({
          request_id: input.requestId,
          phase: "export_revoke",
          phase_order: 3,
          status: "pending",
          idempotency_key_digest: input.idempotencyKeyDigest,
          next_attempt_at: input.nextAttemptAt,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflictDoNothing();
    });
  }

  async findExportRevocationsDue(
    now: Date,
    limit: number,
  ): Promise<Array<{ requestId: string; requestDigest: string }>> {
    const rows = await dbWrite
      .select({
        requestId: accountDeletionRequests.id,
        requestDigest: accountDeletionRequests.request_digest,
      })
      .from(accountDeletionPhaseReceipts)
      .innerJoin(
        accountDeletionRequests,
        eq(accountDeletionRequests.id, accountDeletionPhaseReceipts.request_id),
      )
      .where(
        and(
          eq(accountDeletionPhaseReceipts.phase, "export_revoke"),
          notInArray(accountDeletionPhaseReceipts.status, [
            "completed",
            "canceled",
            "action_required",
          ]),
          or(
            isNull(accountDeletionPhaseReceipts.next_attempt_at),
            lte(accountDeletionPhaseReceipts.next_attempt_at, now),
          ),
          or(
            isNull(accountDeletionPhaseReceipts.lease_expires_at),
            lte(accountDeletionPhaseReceipts.lease_expires_at, now),
          ),
        ),
      )
      .orderBy(asc(accountDeletionPhaseReceipts.created_at))
      .limit(limit);
    return rows.flatMap((row) =>
      row.requestDigest ? [{ requestId: row.requestId, requestDigest: row.requestDigest }] : [],
    );
  }

  async completeExportRevocation(input: {
    requestId: string;
    phaseReceiptId: string;
    generation: number;
    providerReceiptDigest: string;
    now: Date;
  }): Promise<boolean> {
    return await dbWrite.transaction(async (tx) => {
      const [phase] = await tx
        .update(accountDeletionPhaseReceipts)
        .set({
          status: "completed",
          provider_receipt_digest: input.providerReceiptDigest,
          provider_acknowledged_at: input.now,
          reconciled_at: input.now,
          completed_at: input.now,
          lease_owner_digest: null,
          lease_expires_at: null,
          next_attempt_at: null,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(accountDeletionPhaseReceipts.id, input.phaseReceiptId),
            eq(accountDeletionPhaseReceipts.request_id, input.requestId),
            inArray(accountDeletionPhaseReceipts.status, ["leased", "calling", "reconciling"]),
            eq(accountDeletionPhaseReceipts.lease_generation, input.generation),
          ),
        )
        .returning({ id: accountDeletionPhaseReceipts.id });
      if (!phase) return false;
      const [exportReceipt] = await tx
        .update(accountDeletionExports)
        .set({
          status: "deleted",
          content_digest: null,
          object_receipt_digest: input.providerReceiptDigest,
          byte_count: null,
          deleted_at: input.now,
          last_error_code: null,
          updated_at: input.now,
        })
        .where(eq(accountDeletionExports.request_id, input.requestId))
        .returning({ id: accountDeletionExports.id });
      if (!exportReceipt) {
        throw new ElizaError("Deletion export receipt disappeared during revocation", {
          code: "ACCOUNT_DELETION_EXPORT_REVOCATION_RECEIPT_MISSING",
          severity: "fatal",
        });
      }
      return true;
    });
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

  async createIdempotent(data: NewAccountDeletionRequest): Promise<AccountDeletionRequest> {
    const [created] = await dbWrite
      .insert(accountDeletionRequests)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    if (!data.user_id || !data.organization_id) {
      throw new ElizaError("Account deletion request requires user and organization IDs", {
        code: "ACCOUNT_DELETION_REQUEST_IDENTIFIERS_REQUIRED",
        severity: "fatal",
      });
    }
    const existing = await this.findOpenByUserAndOrganizationId(
      data.user_id,
      data.organization_id,
      true,
    );
    if (!existing) {
      throw new ElizaError("Account deletion request conflicted but no open request was found", {
        code: "ACCOUNT_DELETION_CONFLICT_RECEIPT_MISSING",
        severity: "fatal",
      });
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

  async claimDue(limit: number, now = new Date()): Promise<AccountDeletionRequest[]> {
    return await dbWrite.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.status, "scheduled"),
            lte(accountDeletionRequests.execute_after, now),
            isNull(accountDeletionRequests.request_digest),
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
          eq(accountDeletionRequests.processing_started_at, processingStartedAt),
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
          eq(accountDeletionRequests.processing_started_at, processingStartedAt),
        ),
      )
      .returning();
    return updated;
  }
}

export const accountDeletionRequestsRepository = new AccountDeletionRequestsRepository();
