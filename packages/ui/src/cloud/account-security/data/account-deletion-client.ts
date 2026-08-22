/** Provides the typed browser client for account-deletion status and request endpoints. */

import { api } from "../../lib/api-client";

export interface AccountDeletionRequestDto {
  requestId: string;
  status:
    | "requested"
    | "scheduled"
    | "processing"
    | "completed"
    | "action_required";
  requestedAt: string;
  scheduledDeletionAt: string;
  identityDeactivated: boolean;
  completedAt: string | null;
}

export interface AccountDeletionSupportPath {
  email: string;
  href: string;
}

export type AccountDeletionAvailability =
  | {
      status: "available";
      request: null;
      support: null;
    }
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

function isRequest(value: unknown): value is AccountDeletionRequestDto {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.requestId === "string" &&
    typeof request.status === "string" &&
    [
      "requested",
      "scheduled",
      "processing",
      "completed",
      "action_required",
    ].includes(request.status) &&
    typeof request.requestedAt === "string" &&
    typeof request.scheduledDeletionAt === "string" &&
    typeof request.identityDeactivated === "boolean" &&
    (request.completedAt === null || typeof request.completedAt === "string")
  );
}

function parseAvailability(value: unknown): AccountDeletionAvailability {
  if (!value || typeof value !== "object") {
    throw new Error("Account deletion availability response was malformed");
  }
  const projection = value as Record<string, unknown>;
  if (
    projection.status === "available" &&
    projection.request === null &&
    projection.support === null
  ) {
    return { status: "available", request: null, support: null };
  }
  if (
    projection.status === "existing_receipt" &&
    isRequest(projection.request) &&
    projection.support === null
  ) {
    return {
      status: "existing_receipt",
      request: projection.request,
      support: null,
    };
  }
  const support =
    projection.support !== null && typeof projection.support === "object"
      ? (projection.support as Record<string, unknown>)
      : null;
  if (
    (projection.status === "transfer_required" ||
      projection.status === "lifecycle_unavailable") &&
    projection.request === null &&
    typeof support?.email === "string" &&
    typeof support.href === "string" &&
    support.href.startsWith("mailto:")
  ) {
    return {
      status: projection.status,
      request: null,
      support: { email: support.email, href: support.href },
    };
  }
  throw new Error("Account deletion availability response was malformed");
}

export async function getAccountDeletionAvailability(): Promise<AccountDeletionAvailability> {
  return parseAvailability(await api<unknown>("/api/v1/me/account-deletion"));
}

export async function submitAccountDeletion(): Promise<AccountDeletionRequestDto> {
  const response = await api<unknown>("/api/v1/me/account-deletion", {
    method: "POST",
    json: { confirmation: "DELETE" },
  });
  if (response && typeof response === "object") {
    const request = (response as Record<string, unknown>).request;
    if (isRequest(request)) return request;
  }
  throw new Error("Account deletion request response was malformed");
}

export async function endLocalSessionAfterDeletion(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // error-policy:J4 A successful deletion response can invalidate logout authentication.
    // The account is already inactive, so the logout endpoint can reject its
    // now-invalid token. Navigation still leaves the protected application.
  }
}
