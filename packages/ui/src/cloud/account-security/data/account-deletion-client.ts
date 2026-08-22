/** Provides the typed browser client for account-deletion status and request endpoints. */

import { logger } from "@elizaos/logger";
import { api } from "../../lib/api-client";

export interface AccountDeletionRequestDto {
  requestId: string;
  status: string;
  requestedAt: string;
  scheduledDeletionAt: string;
  identityDeactivated: boolean;
  completedAt: string | null;
}

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

function parseRequest(value: unknown): AccountDeletionRequestDto {
  if (!isRecord(value))
    throw new Error("Account deletion receipt was malformed");
  const completedAt = value.completedAt;
  if (
    typeof value.requestId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.requestedAt !== "string" ||
    typeof value.scheduledDeletionAt !== "string" ||
    typeof value.identityDeactivated !== "boolean" ||
    (completedAt !== null && typeof completedAt !== "string")
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
  const response = await api<{ request: AccountDeletionRequestDto }>(
    "/api/v1/me/account-deletion",
    { method: "POST", json: { confirmation: "DELETE" } },
  );
  return response.request;
}

export async function endLocalSessionAfterDeletion(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    // error-policy:J6 Logout is best-effort teardown after the server has retired the account.
    // The account is already inactive, so the logout endpoint can reject its
    // now-invalid token. Navigation still leaves the protected application.
    logger.warn(
      { error },
      "[AccountDeletionClient] Logout failed after account deletion",
    );
  }
}
