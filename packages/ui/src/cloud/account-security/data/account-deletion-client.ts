/** Provides the typed browser client for account-deletion lifecycle endpoints. */

import type {
  AccountDeletionAcceptedDto,
  AccountDeletionStatusDto,
} from "@elizaos/cloud-shared/types/account-lifecycle";
import { api, apiFetch } from "../../lib/api-client";
import { signOutFromSsoBridgedHost } from "../../sso-bridge/sso-bridge";

const STATUS_CREDENTIAL_KEY = "eliza.account-deletion.status.v1";
const RECOVERY_CREDENTIAL_KEY = "eliza.account-deletion.recovery.v1";
const volatileCredentials = new Map<string, string>();

function readSessionCredential(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return (
      window.sessionStorage.getItem(key) ?? volatileCredentials.get(key) ?? null
    );
  } catch {
    // error-policy:J4 a storage-denied browser retains capabilities only for
    // the current renderer lifetime and never substitutes a public identifier.
    return volatileCredentials.get(key) ?? null;
  }
}

function writeSessionCredential(key: string, value: string): void {
  if (typeof window === "undefined") return;
  volatileCredentials.set(key, value);
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // error-policy:J4 a storage-denied browser can still use the accepted
    // capability from volatile memory until this renderer exits.
  }
}

function removeSessionCredential(key: string): void {
  if (typeof window === "undefined") return;
  volatileCredentials.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // error-policy:J4 the volatile copy is already removed and the consumed
    // recovery capability is invalid server-side.
  }
}

export function rememberAccountDeletionCapabilities(
  accepted: AccountDeletionAcceptedDto,
): void {
  writeSessionCredential(STATUS_CREDENTIAL_KEY, accepted.statusCredential);
  writeSessionCredential(RECOVERY_CREDENTIAL_KEY, accepted.recoveryCredential);
}

export async function submitAccountDeletion(): Promise<AccountDeletionAcceptedDto> {
  const accepted = await api<AccountDeletionAcceptedDto>(
    "/api/v1/me/account-deletion",
    { method: "POST", json: { confirmation: "DELETE" } },
  );
  rememberAccountDeletionCapabilities(accepted);
  return accepted;
}

export async function readAccountDeletionStatus(): Promise<AccountDeletionStatusDto | null> {
  const statusCredential = readSessionCredential(STATUS_CREDENTIAL_KEY);
  if (!statusCredential) return null;
  const response = await api<{ request: AccountDeletionStatusDto }>(
    "/api/public/account-deletion",
    {
      skipAuth: true,
      headers: { "X-Account-Deletion-Status": statusCredential },
    },
  );
  return response.request;
}

export async function cancelAccountDeletion(): Promise<AccountDeletionStatusDto> {
  const recoveryCredential = readSessionCredential(RECOVERY_CREDENTIAL_KEY);
  if (!recoveryCredential) {
    throw new Error(
      "The recovery capability is unavailable in this browser session.",
    );
  }
  const response = await api<{ request: AccountDeletionStatusDto }>(
    "/api/public/account-deletion",
    {
      method: "DELETE",
      skipAuth: true,
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
      json: { confirmation: "CANCEL DELETION" },
    },
  );
  removeSessionCredential(RECOVERY_CREDENTIAL_KEY);
  return response.request;
}

export interface AccountDeletionExportDownload {
  blob: Blob;
  contentDigest: string;
  filename: string;
}

export async function downloadAccountDeletionExport(): Promise<AccountDeletionExportDownload> {
  const recoveryCredential = readSessionCredential(RECOVERY_CREDENTIAL_KEY);
  if (!recoveryCredential) {
    throw new Error(
      "The recovery capability is unavailable in this browser session.",
    );
  }
  const response = await apiFetch("/api/public/account-deletion/export", {
    method: "POST",
    skipAuth: true,
    headers: { "X-Account-Deletion-Recovery": recoveryCredential },
    json: { confirmation: "EXPORT MY DATA" },
  });
  const contentDigest =
    response.headers.get("X-Account-Deletion-Export-SHA256") ?? "";
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) {
    throw new Error(
      "The deletion export response has no valid content digest.",
    );
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filenameMatch = /filename="([A-Za-z0-9._-]+)"/.exec(disposition);
  const blob = await response.blob();
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify the deletion export digest.");
  }
  const actualDigest = Array.from(
    new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        await blob.arrayBuffer(),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actualDigest !== contentDigest) {
    throw new Error(
      "The deletion export bytes do not match the server receipt.",
    );
  }
  return {
    blob,
    contentDigest,
    filename: filenameMatch?.[1] ?? "eliza-account-export.json",
  };
}

export async function endLocalSessionAfterDeletion(): Promise<void> {
  // Account deletion ends the same complete authority epoch as explicit
  // sign-out: server sessions, Steward JWT storage, native/desktop owner-key
  // mirrors, active-server/profile copies, and mounted auth consumers. The
  // canonical teardown is intentionally awaited so a protected-store denial
  // cannot be presented as a completed local retirement.
  await signOutFromSsoBridgedHost();
}
