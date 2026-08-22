/** Pure account-deletion DTO contract shared by web and Play-safe renderers. */

export type AccountDeletionPhase =
  | "preparing"
  | "recovery_window"
  | "processing"
  | "action_required"
  | "completed"
  | "cancelled";

export type AccountDeletionExportState =
  | "not_requested"
  | "preparing"
  | "ready"
  | "expired"
  | "unavailable";

export interface AccountDeletionProgressDto {
  completedSteps: number;
  totalSteps: number;
  currentStep: string | null;
}

export interface AccountDeletionExportDto {
  status: AccountDeletionExportState;
  downloadUrl: string | null;
  expiresAt: string | null;
}

export interface AccountDeletionRequestDto {
  /** Non-identifying support receipt, not a user, organization, or provider ID. */
  requestId: string;
  phase: AccountDeletionPhase;
  requestedAt: string;
  recoveryEndsAt: string | null;
  scheduledDeletionAt: string | null;
  completedAt: string | null;
  identityDeactivated: boolean;
  canCancel: boolean;
  canExport: boolean;
  nextPollAfterMs: number | null;
  progress: AccountDeletionProgressDto | null;
  export: AccountDeletionExportDto;
  actionRequiredCode: string | null;
}

export interface AccountDeletionEnvelope {
  request: unknown;
  /** True only after the server durably reserved post-session status access. */
  statusAccessEstablished?: unknown;
}

const PHASES = new Set<AccountDeletionPhase>([
  "preparing",
  "recovery_window",
  "processing",
  "action_required",
  "completed",
  "cancelled",
]);

const EXPORT_STATES = new Set<AccountDeletionExportState>([
  "not_requested",
  "preparing",
  "ready",
  "expired",
  "unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error(`Account deletion response has an invalid ${field}`);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Account deletion response has an invalid ${field}`);
}

function parseProgress(value: unknown): AccountDeletionProgressDto | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error("Account deletion response has invalid progress");
  }
  const completedSteps = finiteNumber(value.completedSteps, "completedSteps");
  const totalSteps = finiteNumber(value.totalSteps, "totalSteps");
  if (completedSteps < 0 || totalSteps < 0 || completedSteps > totalSteps) {
    throw new Error("Account deletion response has inconsistent progress");
  }
  return {
    completedSteps,
    totalSteps,
    currentStep: nullableString(value.currentStep, "currentStep"),
  };
}

function parseExport(value: unknown): AccountDeletionExportDto {
  if (
    !isRecord(value) ||
    !EXPORT_STATES.has(value.status as AccountDeletionExportState)
  ) {
    throw new Error("Account deletion response has invalid export status");
  }
  return {
    status: value.status as AccountDeletionExportState,
    downloadUrl: nullableString(value.downloadUrl, "downloadUrl"),
    expiresAt: nullableString(value.expiresAt, "expiresAt"),
  };
}

export function parseAccountDeletionRequest(
  value: unknown,
): AccountDeletionRequestDto {
  if (!isRecord(value)) {
    throw new Error("Account deletion response was malformed");
  }
  if (
    typeof value.requestId !== "string" ||
    !PHASES.has(value.phase as AccountDeletionPhase) ||
    typeof value.requestedAt !== "string" ||
    typeof value.identityDeactivated !== "boolean" ||
    typeof value.canCancel !== "boolean" ||
    typeof value.canExport !== "boolean"
  ) {
    throw new Error("Account deletion response was malformed");
  }
  const nextPollAfterMs =
    value.nextPollAfterMs === null || value.nextPollAfterMs === undefined
      ? null
      : finiteNumber(value.nextPollAfterMs, "nextPollAfterMs");
  return {
    requestId: value.requestId,
    phase: value.phase as AccountDeletionPhase,
    requestedAt: value.requestedAt,
    recoveryEndsAt: nullableString(value.recoveryEndsAt, "recoveryEndsAt"),
    scheduledDeletionAt: nullableString(
      value.scheduledDeletionAt,
      "scheduledDeletionAt",
    ),
    completedAt: nullableString(value.completedAt, "completedAt"),
    identityDeactivated: value.identityDeactivated,
    canCancel: value.canCancel,
    canExport: value.canExport,
    nextPollAfterMs:
      nextPollAfterMs === null
        ? null
        : Math.min(Math.max(nextPollAfterMs, 1_000), 60_000),
    progress: parseProgress(value.progress),
    export: parseExport(value.export),
    actionRequiredCode: nullableString(
      value.actionRequiredCode,
      "actionRequiredCode",
    ),
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
