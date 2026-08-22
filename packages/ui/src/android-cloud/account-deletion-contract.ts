/**
 * Android-owned runtime parser for the identifier-minimal wire contract in
 * account-deletion owner candidate 398b2e79d2681109c3425cc9f21b7262ef882010.
 */

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

export interface AccountDeletionExportDto {
  status: AccountDeletionExportStatus;
  readyAt: string | null;
  expiresAt: string;
  contentDigest: string | null;
}

export interface AccountDeletionRequestDto {
  /** Opaque support receipt. Never treat it as authority. */
  requestId: string;
  status: AccountDeletionStatus;
  requestedAt: string;
  recoveryExpiresAt: string | null;
  scheduledDeletionAt: string;
  irreversibleAt: string | null;
  completedAt: string | null;
  identityDeactivated: boolean;
  canCancel: boolean;
  nextAction: AccountDeletionNextAction;
  export: AccountDeletionExportDto | null;
}

export interface AccountDeletionAcceptedDto {
  request: AccountDeletionRequestDto;
  statusCredential: string;
  recoveryCredential: string;
}

const STATUSES = new Set<AccountDeletionStatus>([
  "reserved",
  "recovery",
  "scheduled",
  "processing",
  "completed",
  "canceled",
  "action_required",
]);

const EXPORT_STATUSES = new Set<AccountDeletionExportStatus>([
  "pending",
  "building",
  "ready",
  "expired",
  "deleted",
  "failed",
]);

const NEXT_ACTIONS = new Set<AccountDeletionNextAction>([
  "wait_for_export",
  "download_export_or_cancel",
  "wait_for_reconciliation",
  "contact_support",
  "none",
]);

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Account deletion response has an invalid ${field}`);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function parseExport(value: unknown): AccountDeletionExportDto | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !EXPORT_STATUSES.has(value.status as AccountDeletionExportStatus)
  ) {
    throw new Error("Account deletion response has invalid export state");
  }
  const contentDigest = nullableString(value.contentDigest, "contentDigest");
  if (contentDigest !== null && !SHA256_PATTERN.test(contentDigest)) {
    throw new Error("Account deletion response has an invalid contentDigest");
  }
  return {
    status: value.status as AccountDeletionExportStatus,
    readyAt: nullableString(value.readyAt, "readyAt"),
    expiresAt: requiredString(value.expiresAt, "expiresAt"),
    contentDigest,
  };
}

export function parseAccountDeletionRequest(
  value: unknown,
): AccountDeletionRequestDto {
  if (
    !isRecord(value) ||
    !STATUSES.has(value.status as AccountDeletionStatus) ||
    typeof value.identityDeactivated !== "boolean" ||
    typeof value.canCancel !== "boolean" ||
    !NEXT_ACTIONS.has(value.nextAction as AccountDeletionNextAction)
  ) {
    throw new Error("Account deletion response was malformed");
  }
  return {
    requestId: requiredString(value.requestId, "requestId"),
    status: value.status as AccountDeletionStatus,
    requestedAt: requiredString(value.requestedAt, "requestedAt"),
    recoveryExpiresAt: nullableString(
      value.recoveryExpiresAt,
      "recoveryExpiresAt",
    ),
    scheduledDeletionAt: requiredString(
      value.scheduledDeletionAt,
      "scheduledDeletionAt",
    ),
    irreversibleAt: nullableString(value.irreversibleAt, "irreversibleAt"),
    completedAt: nullableString(value.completedAt, "completedAt"),
    identityDeactivated: value.identityDeactivated,
    canCancel: value.canCancel,
    nextAction: value.nextAction as AccountDeletionNextAction,
    export: parseExport(value.export),
  };
}

export function parseAccountDeletionEnvelope(
  value: unknown,
): AccountDeletionRequestDto | null {
  if (!isRecord(value) || !("request" in value)) {
    throw new Error("Account deletion response was malformed");
  }
  return value.request === null
    ? null
    : parseAccountDeletionRequest(value.request);
}

function parseCapability(value: unknown, field: string): string {
  if (typeof value === "string" && CAPABILITY_PATTERN.test(value)) {
    return value;
  }
  throw new Error(`Account deletion response has an invalid ${field}`);
}

export function parseAccountDeletionAccepted(
  value: unknown,
): AccountDeletionAcceptedDto {
  if (!isRecord(value)) {
    throw new Error("Account deletion acceptance was malformed");
  }
  const statusCredential = parseCapability(
    value.statusCredential,
    "statusCredential",
  );
  const recoveryCredential = parseCapability(
    value.recoveryCredential,
    "recoveryCredential",
  );
  if (statusCredential === recoveryCredential) {
    throw new Error("Account deletion capabilities must be independent");
  }
  return {
    request: parseAccountDeletionRequest(value.request),
    statusCredential,
    recoveryCredential,
  };
}
