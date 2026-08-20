import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import { apiKeysRepository } from "../../db/repositories/api-keys";
import { usersRepository } from "../../db/repositories/users";
import type { AccountDeletionRequest } from "../../db/schemas/account-deletion-requests";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";
import { purgePersonalOrganizationResources } from "./account-deletion-resource-purge";
import { organizationsService } from "./organizations";
import { deactivateStewardPlatformUser, deleteStewardPlatformUser } from "./steward-platform-users";
import { userSessionsService } from "./user-sessions";
import { usersService } from "./users";

const DELETION_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

export class AccountDeletionConflictError extends Error {
  constructor(message: string) {
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

export async function getOpenAccountDeletionRequest(userId: string) {
  return await accountDeletionRequestsRepository.findOpenByUserId(userId);
}

export interface RequestAccountDeletionDependencies {
  deactivateStewardUser: typeof deactivateStewardPlatformUser;
  updateUser: typeof usersService.update;
  deactivateApiKeys: typeof apiKeysRepository.deactivateByUserAndOrganization;
  endUserSessions: typeof userSessionsService.endAllUserSessions;
  updateOrganization: typeof organizationsService.update;
}

function defaultRequestDependencies(): RequestAccountDeletionDependencies {
  return {
    deactivateStewardUser: deactivateStewardPlatformUser,
    updateUser: (userId, data) => usersService.update(userId, data),
    deactivateApiKeys: (userId, organizationId) =>
      apiKeysRepository.deactivateByUserAndOrganization(userId, organizationId),
    endUserSessions: (userId) => userSessionsService.endAllUserSessions(userId),
    updateOrganization: (organizationId, data) => organizationsService.update(organizationId, data),
  };
}

export async function requestAccountDeletion(
  input: {
    userId: string;
    organizationId: string;
    stewardUserId: string;
    now?: Date;
  },
  dependencies: RequestAccountDeletionDependencies = defaultRequestDependencies(),
): Promise<AccountDeletionRequest> {
  const now = input.now ?? new Date();
  const members = await usersRepository.listByOrganization(input.organizationId);
  const current = members.find((member) => member.id === input.userId);
  if (!current) throw new AccountDeletionConflictError("Account is no longer available");
  if (current.is_anonymous) {
    throw new AccountDeletionConflictError("Anonymous sessions do not have an account to delete");
  }
  if (current.role === "owner" && members.length > 1) {
    const otherOwnerExists = members.some(
      (member) => member.id !== input.userId && member.role === "owner" && member.is_active,
    );
    if (!otherOwnerExists) {
      throw new AccountDeletionConflictError(
        "Transfer organization ownership before deleting this account",
      );
    }
  }

  const request = await accountDeletionRequestsRepository.createIdempotent({
    user_id: input.userId,
    organization_id: input.organizationId,
    steward_user_id: input.stewardUserId,
    status: "requested",
    requested_at: now,
    execute_after: new Date(now.getTime() + DELETION_DELAY_MS),
  });
  if (request.status === "scheduled") return request;

  try {
    await dependencies.deactivateStewardUser(input.stewardUserId);
    await dependencies.updateUser(input.userId, { is_active: false, deleted_at: now });
    await Promise.all([
      dependencies.deactivateApiKeys(input.userId, input.organizationId),
      dependencies.endUserSessions(input.userId),
    ]);
    if (members.length === 1) {
      await dependencies.updateOrganization(input.organizationId, { is_active: false });
    }
    const scheduled = await accountDeletionRequestsRepository.update(request.id, {
      status: "scheduled",
      identity_deactivated_at: now,
      last_error_code: null,
    });
    if (!scheduled) throw new Error("Deletion request disappeared during scheduling");
    logger.info("[AccountDeletion] Scheduled account deletion", {
      requestId: scheduled.id,
      userId: input.userId,
      organizationId: input.organizationId,
      executeAfter: scheduled.execute_after.toISOString(),
    });
    return scheduled;
  } catch (error) {
    await accountDeletionRequestsRepository.update(request.id, {
      status: "action_required",
      last_error_code: "deactivation_failed",
    });
    logger.error("[AccountDeletion] Failed to deactivate account", {
      requestId: request.id,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
  deleteStewardUser?: typeof deleteStewardPlatformUser;
  findUserForWrite?: typeof usersRepository.findByIdForWrite;
  listOrganizationMembers?: typeof usersRepository.listByOrganization;
  deletePersonalAccount?: typeof usersService.deletePersonalAccount;
  deleteSharedOrganizationUser?: typeof usersService.delete;
}

/**
 * Executes due requests. The receipt survives account/org deletion and records
 * completion without retaining email, phone, wallet, or other profile data.
 */
export async function processDueAccountDeletions(
  limit = 10,
  resources?: ProcessAccountDeletionResources,
): Promise<ProcessAccountDeletionResult> {
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
      if (!resources?.blob) {
        throw new Error("Account deletion requires the Cloud object-storage binding");
      }
      const members = await (
        resources.listOrganizationMembers ??
        ((organizationId) => usersRepository.listByOrganization(organizationId))
      )(request.organization_id);
      const isPersonalOrganization = members.length === 1 && members[0]?.id === request.user_id;
      if (!isPersonalOrganization && !members.some((member) => member.id === request.user_id)) {
        throw new Error("Cloud user disappeared before database erasure completed");
      }
      if (isPersonalOrganization) {
        await (resources.purgeOrganizationResources ?? purgePersonalOrganizationResources)({
          organizationId: request.organization_id,
          blob: resources.blob,
        });
      }
      await (resources.deleteStewardUser ?? deleteStewardPlatformUser)(request.steward_user_id);
      const user = await (
        resources.findUserForWrite ?? ((userId) => usersRepository.findByIdForWrite(userId))
      )(request.user_id);
      if (!user) {
        throw new Error("Cloud user disappeared before database erasure completed");
      }
      if (isPersonalOrganization) {
        await (
          resources.deletePersonalAccount ??
          ((userId, organizationId) => usersService.deletePersonalAccount(userId, organizationId))
        )(request.user_id, request.organization_id);
      } else {
        await (resources.deleteSharedOrganizationUser ?? ((userId) => usersService.delete(userId)))(
          request.user_id,
        );
      }
      await accountDeletionRequestsRepository.update(request.id, {
        status: "completed",
        completed_at: new Date(),
        last_error_code: null,
        user_id: null,
        organization_id: null,
        steward_user_id: null,
      });
      result.completed++;
      logger.info("[AccountDeletion] Completed account deletion", {
        requestId: request.id,
      });
    } catch (error) {
      const failed = await accountDeletionRequestsRepository.recordPurgeFailure(
        request.id,
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
