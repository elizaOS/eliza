/** Coordinates fail-closed account-deletion requests and fenced worker claims. */

import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import { usersRepository } from "../../db/repositories/users";
import type { AccountDeletionRequest } from "../../db/schemas/account-deletion-requests";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";
import { purgePersonalOrganizationResources } from "./account-deletion-resource-purge";
export type AccountDeletionConflictCode =
  | "ACCOUNT_UNAVAILABLE"
  | "ANONYMOUS_ACCOUNT"
  | "TRANSFER_REQUIRED"
  | "LIFECYCLE_RESERVATION_REQUIRED";

export class AccountDeletionConflictError extends Error {
  constructor(
    message: string,
    readonly code: AccountDeletionConflictCode,
  ) {
    super(message);
    this.name = "AccountDeletionConflictError";
  }
}

export interface AccountDeletionRequestDto {
  requestId: string;
  status: AccountDeletionRequest["status"];
  requestedAt: string;
  scheduledDeletionAt: string;
  identityDeactivated: boolean;
  completedAt: string | null;
}

export type AccountDeletionAvailabilityStatus =
  | "available"
  | "transfer_required"
  | "lifecycle_unavailable"
  | "existing_receipt";

export interface AccountDeletionSupportPath {
  email: string;
  href: string;
}

export type AccountDeletionAvailabilityDto =
  | { status: "available"; request: null; support: null }
  | {
      status: "transfer_required" | "lifecycle_unavailable";
      request: null;
      support: AccountDeletionSupportPath;
    }
  | {
      status: "existing_receipt";
      request: AccountDeletionRequestDto;
      support: null;
    };

const ACCOUNT_DELETION_SUPPORT: AccountDeletionSupportPath = {
  email: "support@eliza.cloud",
  href: "mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request",
};

export function toAccountDeletionRequestDto(
  request: AccountDeletionRequest,
): AccountDeletionRequestDto {
  return {
    requestId: request.id,
    status: request.status,
    requestedAt: request.requested_at.toISOString(),
    scheduledDeletionAt: request.execute_after.toISOString(),
    identityDeactivated: request.identity_deactivated_at !== null,
    completedAt: request.completed_at?.toISOString() ?? null,
  };
}

/**
 * Projects the authenticated account's current deletion-admission state without
 * reserving lifecycle work or changing account authority.
 */
export async function getAccountDeletionAvailability(input: {
  userId: string;
  organizationId: string;
}): Promise<AccountDeletionAvailabilityDto> {
  const existing = await accountDeletionRequestsRepository.findOpenByUserAndOrganization(
    input.userId,
    input.organizationId,
    true,
  );
  if (existing) {
    return {
      status: "existing_receipt",
      request: toAccountDeletionRequestDto(existing),
      support: null,
    };
  }

  const members = await usersRepository.listByOrganizationForWrite(input.organizationId);
  const current = members.find(
    (member) => member.id === input.userId && member.organization_id === input.organizationId,
  );
  if (!current || !current.is_active || current.deleted_at || current.is_anonymous) {
    return {
      status: "lifecycle_unavailable",
      request: null,
      support: ACCOUNT_DELETION_SUPPORT,
    };
  }

  if (
    members.some((member) => member.id !== input.userId && member.is_active && !member.deleted_at)
  ) {
    return {
      status: "transfer_required",
      request: null,
      support: ACCOUNT_DELETION_SUPPORT,
    };
  }

  // The durable lifecycle reservation tracked by #23098 does not exist yet, so
  // no account can truthfully be advertised as available for admission.
  return {
    status: "lifecycle_unavailable",
    request: null,
    support: ACCOUNT_DELETION_SUPPORT,
  };
}

export async function requestAccountDeletion(input: {
  userId: string;
  organizationId: string;
  stewardUserId: string;
  now?: Date;
}): Promise<AccountDeletionRequest> {
  const existing = await accountDeletionRequestsRepository.findOpenByUserId(input.userId, true);
  if (existing) return existing;

  const members = await usersRepository.listByOrganizationForWrite(input.organizationId);
  const current = members.find((member) => member.id === input.userId);
  if (!current || !current.is_active || current.deleted_at) {
    throw new AccountDeletionConflictError("Account is no longer available", "ACCOUNT_UNAVAILABLE");
  }
  if (current.is_anonymous) {
    throw new AccountDeletionConflictError(
      "Anonymous sessions do not have an account to delete",
      "ANONYMOUS_ACCOUNT",
    );
  }
  if (
    members.some((member) => member.id !== input.userId && member.is_active && !member.deleted_at)
  ) {
    throw new AccountDeletionConflictError(
      "Transfer or revoke shared organization resources before deleting this account",
      "TRANSFER_REQUIRED",
    );
  }

  throw new AccountDeletionConflictError(
    "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
    "LIFECYCLE_RESERVATION_REQUIRED",
  );
}

export interface ProcessAccountDeletionResult {
  recovered: number;
  processed: number;
  completed: number;
  actionRequired: number;
}

export interface ProcessAccountDeletionResources {
  blob: RuntimeR2Bucket;
  purgeOrganizationResources?: typeof purgePersonalOrganizationResources;
}

function requireProcessAccountDeletionResources(
  resources: ProcessAccountDeletionResources | undefined,
): asserts resources is ProcessAccountDeletionResources {
  const blob = resources?.blob;
  if (
    !blob ||
    typeof blob.get !== "function" ||
    typeof blob.put !== "function" ||
    typeof blob.delete !== "function"
  ) {
    throw new Error("Account deletion requires a valid Cloud object-storage binding");
  }
  if (!resources.purgeOrganizationResources && typeof blob.list !== "function") {
    throw new Error("Account deletion's default resource purge requires Cloud object listing");
  }
}

/**
 * Evaluates due requests without crossing an irreversible provider boundary.
 * Until the durable reservation in #23098 exists, every claimed deletion is
 * parked for operator action and its identifying receipt remains intact.
 */
export async function processDueAccountDeletions(
  limit = 10,
  resources?: ProcessAccountDeletionResources,
): Promise<ProcessAccountDeletionResult> {
  requireProcessAccountDeletionResources(resources);

  const recovered = await accountDeletionRequestsRepository.recoverStaleProcessing(
    new Date(Date.now() - 15 * 60 * 1_000),
  );
  const due = await accountDeletionRequestsRepository.claimDue(limit);
  const result = { recovered, processed: due.length, completed: 0, actionRequired: 0 };

  for (const request of due) {
    try {
      if (!request.steward_user_id || !request.user_id) {
        throw new Error("Claimed deletion request is missing account identifiers");
      }
      if (!request.organization_id) {
        throw new Error("Claimed deletion request is missing its organization identifier");
      }
      if (!request.processing_started_at) {
        logger.error("[AccountDeletion] Claimed request is missing its generation", {
          requestId: request.id,
        });
        continue;
      }

      // No membership writer shares a lifecycle reservation with this worker. Until #23098
      // provides that contract, every organization-backed permanent deletion must fail closed.
      const parked = await accountDeletionRequestsRepository.markActionRequired(
        request.id,
        request.processing_started_at,
        "LIFECYCLE_RESERVATION_REQUIRED",
      );
      if (!parked) {
        logger.warn("[AccountDeletion] Ignored a stale worker while parking deletion", {
          requestId: request.id,
        });
        continue;
      }
      result.actionRequired++;
      logger.warn("[AccountDeletion] Permanent deletion requires a lifecycle reservation", {
        requestId: request.id,
      });
    } catch (error) {
      // error-policy:J1 The per-request worker boundary records a fenced retry outcome.
      if (!request.processing_started_at) continue;
      const failed = await accountDeletionRequestsRepository.recordPurgeFailure(
        request.id,
        request.processing_started_at,
        "purge_failed",
      );
      if (failed?.status === "action_required") result.actionRequired++;
      logger.error("[AccountDeletion] Account deletion needs operator action", {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
