/** Provides the typed browser client for account-deletion lifecycle endpoints. */

import type {
  AccountDeletionAcceptedDto,
  AccountDeletionStatusDto,
} from "@elizaos/cloud-shared/types/account-lifecycle";
import { api, apiFetch } from "../../lib/api-client";
import { signOutFromSsoBridgedHost } from "../../sso-bridge/sso-bridge";

const STATUS_CREDENTIAL_KEY = "eliza.account-deletion.status.v1";
const RECOVERY_CREDENTIAL_KEY = "eliza.account-deletion.recovery.v1";
const ADMISSION_CREDENTIAL_KEY = "eliza.account-deletion.admission.v1";
const volatileCredentials = new Map<string, string>();

const ACCOUNT_DELETION_STATUSES = new Set<AccountDeletionStatusDto["status"]>([
  "reserved",
  "recovery",
  "canceling",
  "scheduled",
  "processing",
  "completed",
  "canceled",
  "action_required",
]);
const ACCOUNT_DELETION_ACCESS_STATES = new Set<
  AccountDeletionStatusDto["accessState"]
>(["fenced", "active", "erased"]);
const ACCOUNT_DELETION_NEXT_ACTIONS = new Set<
  AccountDeletionStatusDto["nextAction"]
>([
  "wait_for_export",
  "download_export_or_cancel",
  "wait_for_reconciliation",
  "contact_support",
  "none",
]);
const ACCOUNT_DELETION_EXPORT_STATUSES = new Set<
  NonNullable<AccountDeletionStatusDto["export"]>["status"]
>(["pending", "building", "ready", "expired", "deleted", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableServerTimestamp(value: unknown): value is string | null {
  return value === null || isServerTimestamp(value);
}

function expectedProjection(status: AccountDeletionStatusDto["status"]): {
  accessState: AccountDeletionStatusDto["accessState"];
  canCancel: boolean;
  nextAction: AccountDeletionStatusDto["nextAction"];
} {
  switch (status) {
    case "reserved":
      return {
        accessState: "fenced",
        canCancel: true,
        nextAction: "wait_for_export",
      };
    case "recovery":
      return {
        accessState: "fenced",
        canCancel: true,
        nextAction: "download_export_or_cancel",
      };
    case "canceling":
    case "scheduled":
    case "processing":
      return {
        accessState: "fenced",
        canCancel: false,
        nextAction: "wait_for_reconciliation",
      };
    case "action_required":
      return {
        accessState: "fenced",
        canCancel: false,
        nextAction: "contact_support",
      };
    case "completed":
      return { accessState: "erased", canCancel: false, nextAction: "none" };
    case "canceled":
      return { accessState: "active", canCancel: false, nextAction: "none" };
  }
}

function parseExport(value: unknown): AccountDeletionStatusDto["export"] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !ACCOUNT_DELETION_EXPORT_STATUSES.has(
      value.status as NonNullable<AccountDeletionStatusDto["export"]>["status"],
    ) ||
    !isNullableServerTimestamp(value.readyAt) ||
    !isServerTimestamp(value.expiresAt) ||
    (value.contentDigest !== null &&
      (typeof value.contentDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.contentDigest)))
  ) {
    throw new Error("Account deletion receipt was malformed");
  }
  return {
    status: value.status as NonNullable<
      AccountDeletionStatusDto["export"]
    >["status"],
    readyAt: value.readyAt,
    expiresAt: value.expiresAt,
    contentDigest: value.contentDigest,
  };
}

function parseStatus(value: unknown): AccountDeletionStatusDto {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.requestId,
    ) ||
    !ACCOUNT_DELETION_STATUSES.has(
      value.status as AccountDeletionStatusDto["status"],
    ) ||
    !isServerTimestamp(value.requestedAt) ||
    !isNullableServerTimestamp(value.recoveryExpiresAt) ||
    !isServerTimestamp(value.scheduledDeletionAt) ||
    !isNullableServerTimestamp(value.irreversibleAt) ||
    !isNullableServerTimestamp(value.completedAt) ||
    typeof value.identityDeactivated !== "boolean" ||
    !ACCOUNT_DELETION_ACCESS_STATES.has(
      value.accessState as AccountDeletionStatusDto["accessState"],
    ) ||
    typeof value.canCancel !== "boolean" ||
    !ACCOUNT_DELETION_NEXT_ACTIONS.has(
      value.nextAction as AccountDeletionStatusDto["nextAction"],
    )
  ) {
    throw new Error("Account deletion receipt was malformed");
  }

  const status = value.status as AccountDeletionStatusDto["status"];
  const projection = expectedProjection(status);
  if (
    value.accessState !== projection.accessState ||
    value.canCancel !== projection.canCancel ||
    value.nextAction !== projection.nextAction
  ) {
    throw new Error("Account deletion receipt was malformed");
  }

  return {
    requestId: value.requestId,
    status,
    requestedAt: value.requestedAt,
    recoveryExpiresAt: value.recoveryExpiresAt,
    scheduledDeletionAt: value.scheduledDeletionAt,
    irreversibleAt: value.irreversibleAt,
    completedAt: value.completedAt,
    identityDeactivated: value.identityDeactivated,
    accessState: value.accessState as AccountDeletionStatusDto["accessState"],
    canCancel: value.canCancel,
    nextAction: value.nextAction as AccountDeletionStatusDto["nextAction"],
    export: parseExport(value.export),
  };
}

function parseStatusEnvelope(value: unknown): AccountDeletionStatusDto {
  if (!isRecord(value)) {
    throw new Error("Account deletion receipt was malformed");
  }
  return parseStatus(value.request);
}

function parseAccepted(value: unknown): AccountDeletionAcceptedDto {
  if (
    !isRecord(value) ||
    typeof value.statusCredential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.statusCredential) ||
    typeof value.recoveryCredential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.recoveryCredential) ||
    value.statusCredential === value.recoveryCredential
  ) {
    throw new Error("Account deletion receipt was malformed");
  }
  return {
    request: parseStatus(value.request),
    statusCredential: value.statusCredential,
    recoveryCredential: value.recoveryCredential,
  };
}

function readSessionCredential(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
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

function createAdmissionCredential(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This browser cannot create secure deletion authority.");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getOrCreateAdmissionCredential(): string {
  const current = readSessionCredential(ADMISSION_CREDENTIAL_KEY);
  if (current && /^[A-Za-z0-9_-]{43}$/.test(current)) return current;
  const created = createAdmissionCredential();
  writeSessionCredential(ADMISSION_CREDENTIAL_KEY, created);
  return created;
}

export function rememberAccountDeletionCapabilities(
  accepted: AccountDeletionAcceptedDto,
): void {
  writeSessionCredential(STATUS_CREDENTIAL_KEY, accepted.statusCredential);
  writeSessionCredential(RECOVERY_CREDENTIAL_KEY, accepted.recoveryCredential);
}

export async function submitAccountDeletion(): Promise<AccountDeletionAcceptedDto> {
  // Persist before the destructive request. A network failure leaves this
  // one-time authority available to recover the already-committed receipt.
  const admissionCredential = getOrCreateAdmissionCredential();
  const accepted = parseAccepted(
    await api<unknown>("/api/v1/me/account-deletion", {
      method: "POST",
      json: { confirmation: "DELETE", admissionCredential },
    }),
  );
  rememberAccountDeletionCapabilities(accepted);
  removeSessionCredential(ADMISSION_CREDENTIAL_KEY);
  return accepted;
}

export async function readAccountDeletionStatus(): Promise<AccountDeletionStatusDto | null> {
  const statusCredential = readSessionCredential(STATUS_CREDENTIAL_KEY);
  if (!statusCredential) return null;
  const response = await api<unknown>("/api/public/account-deletion", {
    skipAuth: true,
    headers: { "X-Account-Deletion-Status": statusCredential },
  });
  return parseStatusEnvelope(response);
}

export async function cancelAccountDeletion(): Promise<AccountDeletionStatusDto> {
  const recoveryCredential = readSessionCredential(RECOVERY_CREDENTIAL_KEY);
  if (!recoveryCredential) {
    throw new Error(
      "The recovery capability is unavailable in this browser session.",
    );
  }
  const response = await api<unknown>("/api/public/account-deletion", {
    method: "DELETE",
    skipAuth: true,
    headers: { "X-Account-Deletion-Recovery": recoveryCredential },
    json: { confirmation: "CANCEL DELETION" },
  });
  const status = parseStatusEnvelope(response);
  removeSessionCredential(RECOVERY_CREDENTIAL_KEY);
  return status;
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
