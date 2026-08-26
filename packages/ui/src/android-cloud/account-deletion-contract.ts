/**
 * Android-owned runtime parser for the identifier-minimal wire contract in
 * frozen account-deletion admission contract at PR #25738 head 90343b7265.
 */

export type AccountDeletionStatus =
  | "reserved"
  | "recovery"
  | "canceling"
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

export type AccountDeletionAccessState = "fenced" | "active" | "erased";

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
  accessState: AccountDeletionAccessState;
  canCancel: boolean;
  nextAction: AccountDeletionNextAction;
  export: AccountDeletionExportDto | null;
}

export interface AccountDeletionAcceptedDto {
  request: AccountDeletionRequestDto;
  statusCredential: string;
  recoveryCredential: string;
}

export type AccountDeletionAvailabilityDto =
  | { state: "available"; request: null }
  | { state: "existing_request"; request: AccountDeletionRequestDto }
  | {
      state: "transfer_required";
      request: null;
      code: "TRANSFER_REQUIRED";
      message: string;
    }
  | {
      state: "lifecycle_unavailable";
      request: null;
      code: "LIFECYCLE_RESERVATION_REQUIRED";
      message: string;
    };

const STATUSES = new Set<AccountDeletionStatus>([
  "reserved",
  "recovery",
  "canceling",
  "scheduled",
  "processing",
  "completed",
  "canceled",
  "action_required",
]);

const ACCESS_STATES = new Set<AccountDeletionAccessState>([
  "fenced",
  "active",
  "erased",
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

const STATUS_CONTRACT: Readonly<
  Record<
    AccountDeletionStatus,
    {
      accessState: AccountDeletionAccessState;
      canCancel: boolean;
      nextAction: AccountDeletionNextAction;
    }
  >
> = {
  reserved: {
    accessState: "fenced",
    canCancel: true,
    nextAction: "wait_for_export",
  },
  recovery: {
    accessState: "fenced",
    canCancel: true,
    nextAction: "download_export_or_cancel",
  },
  canceling: {
    accessState: "fenced",
    canCancel: false,
    nextAction: "wait_for_reconciliation",
  },
  scheduled: {
    accessState: "fenced",
    canCancel: false,
    nextAction: "wait_for_reconciliation",
  },
  processing: {
    accessState: "fenced",
    canCancel: false,
    nextAction: "wait_for_reconciliation",
  },
  action_required: {
    accessState: "fenced",
    canCancel: false,
    nextAction: "contact_support",
  },
  completed: {
    accessState: "erased",
    canCancel: false,
    nextAction: "none",
  },
  canceled: {
    accessState: "active",
    canCancel: false,
    nextAction: "none",
  },
};

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
    !ACCESS_STATES.has(value.accessState as AccountDeletionAccessState) ||
    typeof value.canCancel !== "boolean" ||
    !NEXT_ACTIONS.has(value.nextAction as AccountDeletionNextAction)
  ) {
    throw new Error("Account deletion response was malformed");
  }
  const parsed: AccountDeletionRequestDto = {
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
    accessState: value.accessState as AccountDeletionAccessState,
    canCancel: value.canCancel,
    nextAction: value.nextAction as AccountDeletionNextAction,
    export: parseExport(value.export),
  };
  const expected = STATUS_CONTRACT[parsed.status];
  if (
    parsed.accessState !== expected.accessState ||
    parsed.canCancel !== expected.canCancel ||
    parsed.nextAction !== expected.nextAction
  ) {
    throw new Error(
      "Account deletion response has inconsistent lifecycle state",
    );
  }
  return parsed;
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

/**
 * Normalizes both the current fail-closed admission response and the reserved
 * lifecycle owner's identifier-minimal `{ request }` response.
 */
export function parseAccountDeletionAvailability(
  value: unknown,
): AccountDeletionAvailabilityDto {
  if (!isRecord(value) || !("request" in value)) {
    throw new Error("Account deletion availability response was malformed");
  }
  if (value.request !== null) {
    return {
      state: "existing_request",
      request: parseAccountDeletionRequest(value.request),
    };
  }
  if (value.state === undefined || value.state === "available") {
    return { state: "available", request: null };
  }
  if (
    value.state === "transfer_required" &&
    value.code === "TRANSFER_REQUIRED" &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return {
      state: value.state,
      request: null,
      code: value.code,
      message: value.message,
    };
  }
  if (
    value.state === "lifecycle_unavailable" &&
    value.code === "LIFECYCLE_RESERVATION_REQUIRED" &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return {
      state: value.state,
      request: null,
      code: value.code,
      message: value.message,
    };
  }
  throw new Error("Account deletion availability response was malformed");
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
