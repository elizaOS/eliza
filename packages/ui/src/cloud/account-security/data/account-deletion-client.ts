/** Provides the typed browser client for account-deletion status and request endpoints. */

import { api } from "../../lib/api-client";

export interface AccountDeletionRequestDto {
  requestId: string;
  status: string;
  requestedAt: string;
  scheduledDeletionAt: string;
  identityDeactivated: boolean;
  completedAt: string | null;
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
  } catch {
    // The account is already inactive, so the logout endpoint can reject its
    // now-invalid token. Navigation still leaves the protected application.
  }
}
