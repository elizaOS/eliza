/** Public, identifier-minimal contracts for distinct account lifecycle operations. */

export type AccountLifecycleOperationKind =
  | "agent_control"
  | "subscription_cancellation"
  | "shared_member_exit"
  | "personal_account_deletion";

export interface AccountLifecycleOperationContract {
  authority: string;
  recentAuthRequired: boolean;
  reversible: boolean;
  consequence: string;
  explicitlyDoesNot: readonly string[];
}

export const ACCOUNT_LIFECYCLE_OPERATION_CONTRACTS: Readonly<
  Record<AccountLifecycleOperationKind, AccountLifecycleOperationContract>
> = {
  agent_control: {
    authority: "organization runtime permission for one agent",
    recentAuthRequired: false,
    reversible: true,
    consequence: "Stops or wakes one agent without changing account or billing ownership.",
    explicitlyDoesNot: ["cancel subscriptions", "exit a shared organization", "delete an account"],
  },
  subscription_cancellation: {
    authority: "organization billing owner",
    recentAuthRequired: true,
    reversible: true,
    consequence: "Cancels future subscription renewal while preserving the account and its data.",
    explicitlyDoesNot: ["stop agents immediately", "remove members", "delete account data"],
  },
  shared_member_exit: {
    authority: "the departing member plus an active successor owner when ownership is held",
    recentAuthRequired: true,
    reversible: false,
    consequence: "Transfers or revokes the member's grants, then removes only that membership.",
    explicitlyDoesNot: [
      "delete shared assets",
      "cancel organization billing",
      "leave the organization without an owner",
    ],
  },
  personal_account_deletion: {
    authority: "the exact recently authenticated personal account",
    recentAuthRequired: true,
    reversible: false,
    consequence:
      "Fences new work, provides export and recovery, then permanently erases personal data and reconciles providers.",
    explicitlyDoesNot: [
      "delete a shared organization",
      "transfer ownership implicitly",
      "treat session revocation as completion",
    ],
  },
};

export type AccountDeletionStatus =
  | "reserved"
  | "recovery"
  | "scheduled"
  | "processing"
  | "completed"
  | "canceled"
  | "action_required";

export type AccountDeletionExportStatus =
  | "pending"
  | "building"
  | "ready"
  | "expired"
  | "deleted"
  | "failed";

export type AccountDeletionNextAction =
  | "wait_for_export"
  | "download_export_or_cancel"
  | "wait_for_reconciliation"
  | "contact_support"
  | "none";

export interface AccountDeletionStatusDto {
  requestId: string;
  status: AccountDeletionStatus;
  requestedAt: string;
  recoveryExpiresAt: string | null;
  scheduledDeletionAt: string;
  irreversibleAt: string | null;
  completedAt: string | null;
  /** Transitional projection for clients predating the lifecycle contract. */
  identityDeactivated: boolean;
  canCancel: boolean;
  nextAction: AccountDeletionNextAction;
  export: {
    status: AccountDeletionExportStatus;
    readyAt: string | null;
    expiresAt: string;
    contentDigest: string | null;
  } | null;
}

/** Returned only on initial acceptance; the server never persists either capability in plaintext. */
export interface AccountDeletionAcceptedDto {
  request: AccountDeletionStatusDto;
  statusCredential: string;
  recoveryCredential: string;
}

export type AccountDeletionApiErrorCode =
  | "ACCOUNT_UNAVAILABLE"
  | "ANONYMOUS_ACCOUNT"
  | "CONFIRMATION_REQUIRED"
  | "RECENT_AUTH_REQUIRED"
  | "TRANSFER_REQUIRED"
  | "STATUS_CREDENTIAL_INVALID"
  | "RECOVERY_WINDOW_EXPIRED"
  | "REQUEST_REPLAYED";

export interface SharedMemberTransferRequiredDto {
  code: "TRANSFER_REQUIRED";
  successorOwnerRequired: true;
  activeOwnerCount: number;
  transferableResourceKinds: readonly string[];
}
