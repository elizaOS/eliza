/** Provides the typed browser client for account-deletion status and request endpoints. */

import { api } from "../../lib/api-client";
import { signOutFromSsoBridgedHost } from "../../sso-bridge/sso-bridge";

export interface AccountDeletionRequestDto {
  requestId: string;
  status: AccountDeletionRequestStatus;
  requestedAt: string;
  scheduledDeletionAt: string;
  identityDeactivated: boolean;
  completedAt: string | null;
}

export type AccountDeletionRequestStatus =
  | "requested"
  | "scheduled"
  | "processing"
  | "completed"
  | "action_required";

const ACCOUNT_DELETION_REQUEST_STATUSES = new Set<AccountDeletionRequestStatus>(
  ["requested", "scheduled", "processing", "completed", "action_required"],
);

export type AccountDeletionStatusDto =
  | { state: "available"; request: null }
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
    }
  | { state: "existing_request"; request: AccountDeletionRequestDto };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAccountDeletionRequestStatus(
  value: unknown,
): value is AccountDeletionRequestStatus {
  return (
    typeof value === "string" &&
    ACCOUNT_DELETION_REQUEST_STATUSES.has(value as AccountDeletionRequestStatus)
  );
}

function isServerTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function parseRequest(value: unknown): AccountDeletionRequestDto {
  if (!isRecord(value))
    throw new Error("Account deletion receipt was malformed");
  const completedAt = value.completedAt;
  if (
    typeof value.requestId !== "string" ||
    value.requestId.trim().length === 0 ||
    !isAccountDeletionRequestStatus(value.status) ||
    !isServerTimestamp(value.requestedAt) ||
    !isServerTimestamp(value.scheduledDeletionAt) ||
    typeof value.identityDeactivated !== "boolean" ||
    (completedAt !== null && !isServerTimestamp(completedAt))
  ) {
    throw new Error("Account deletion receipt was malformed");
  }
  return {
    requestId: value.requestId,
    status: value.status,
    requestedAt: value.requestedAt,
    scheduledDeletionAt: value.scheduledDeletionAt,
    identityDeactivated: value.identityDeactivated,
    completedAt,
  };
}

function parseStatus(value: unknown): AccountDeletionStatusDto {
  if (!isRecord(value) || typeof value.state !== "string") {
    throw new Error("Account deletion availability response was malformed");
  }
  if (value.state === "available" && value.request === null) {
    return { state: "available", request: null };
  }
  if (value.state === "existing_request") {
    return { state: "existing_request", request: parseRequest(value.request) };
  }
  if (
    value.state === "transfer_required" &&
    value.request === null &&
    value.code === "TRANSFER_REQUIRED" &&
    typeof value.message === "string"
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
    value.request === null &&
    value.code === "LIFECYCLE_RESERVATION_REQUIRED" &&
    typeof value.message === "string"
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

export async function getAccountDeletionStatus(): Promise<AccountDeletionStatusDto> {
  return parseStatus(await api<unknown>("/api/v1/me/account-deletion"));
}

export async function submitAccountDeletion(): Promise<AccountDeletionRequestDto> {
  const response = await api<unknown>("/api/v1/me/account-deletion", {
    method: "POST",
    json: { confirmation: "DELETE" },
  });
  if (!isRecord(response))
    throw new Error("Account deletion receipt was malformed");
  return parseRequest(response.request);
}

export async function endLocalSessionAfterDeletion(): Promise<void> {
  // Account deletion ends the same complete authority epoch as explicit
  // sign-out: server sessions, Steward JWT storage, native/desktop owner-key
  // mirrors, active-server/profile copies, and mounted auth consumers. The
  // canonical teardown is intentionally awaited so a protected-store denial
  // cannot be presented as a completed local retirement.
  await signOutFromSsoBridgedHost();
}
