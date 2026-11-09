/**
 * Provides the typed browser client for account-deletion lifecycle endpoints.
 *
 * The recovery package is a bearer capability scoped to this browser profile.
 * Shell-privileged local storage preserves it across tab, browser, and OS
 * restarts, but it is intentionally not inferred on a second device and cannot
 * survive explicit site-data clearing. Same-origin script compromise could read
 * it, so CSP and surface-realm isolation remain part of the security boundary.
 * The server stores only hashes and activation remains fail-closed unless every
 * capability completes an exact durable-storage round trip.
 */

import type {
  AccountDeletionAcceptedDto,
  AccountDeletionStatusDto,
} from "@elizaos/cloud-sdk/browser-contracts";
import { ElizaError } from "@elizaos/core/protocol";
import { shellLocalStorage } from "../../../surface-realm-channel";
import { ApiError, api, apiFetch } from "../../lib/api-client";
import { signOutFromSsoBridgedHost } from "../../sso-bridge/sso-bridge";

// One record holds every deletion request this browser can still act on, so a
// second account on the same profile never overwrites the first's recovery
// authority. The v1 single-request keys are migrated into it once.
const REQUESTS_KEY = "eliza.account-deletion.requests.v2";
const LEGACY_STATUS_CREDENTIAL_KEY = "eliza.account-deletion.status.v1";
const LEGACY_RECOVERY_CREDENTIAL_KEY = "eliza.account-deletion.recovery.v1";
const LEGACY_ADMISSION_CREDENTIAL_KEY = "eliza.account-deletion.admission.v1";
const MAX_STORED_REQUESTS = 8;

export type AccountDeletionClientErrorCode =
  | "ACCOUNT_DELETION_ACTIVATION_PENDING"
  | "ACCOUNT_DELETION_CAPABILITY_STORAGE_UNAVAILABLE"
  | "ACCOUNT_DELETION_CAPABILITY_STORE_FULL"
  | "ACCOUNT_DELETION_EXPORT_CRYPTO_UNAVAILABLE"
  | "ACCOUNT_DELETION_EXPORT_DIGEST_INVALID"
  | "ACCOUNT_DELETION_EXPORT_DIGEST_MISMATCH"
  | "ACCOUNT_DELETION_RECEIPT_INVALID"
  | "ACCOUNT_DELETION_RECOVERY_CAPABILITY_UNAVAILABLE"
  | "ACCOUNT_DELETION_SECURE_RANDOM_UNAVAILABLE";

/** Typed browser-boundary failure that never includes an opaque capability. */
export class AccountDeletionClientError extends ElizaError {
  override readonly name = "AccountDeletionClientError";
  override readonly code: AccountDeletionClientErrorCode;
  /** The saved request a pending-activation failure refers to. */
  readonly requestId: string | null;

  constructor(
    message: string,
    options: {
      code: AccountDeletionClientErrorCode;
      cause?: unknown;
      severity?: "ephemeral" | "fatal";
      requestId?: string;
    },
  ) {
    super(message, options);
    this.code = options.code;
    this.requestId = options.requestId ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function invalidReceipt(): AccountDeletionClientError {
  return new AccountDeletionClientError(
    "Account deletion receipt was malformed",
    { code: "ACCOUNT_DELETION_RECEIPT_INVALID", severity: "fatal" },
  );
}

const ACCOUNT_DELETION_STATUSES = new Set<AccountDeletionStatusDto["status"]>([
  "pending_activation",
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
  "confirm_recovery_package",
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
    case "pending_activation":
      return {
        accessState: "active",
        canCancel: false,
        nextAction: "confirm_recovery_package",
      };
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
    throw invalidReceipt();
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
    throw invalidReceipt();
  }

  const status = value.status as AccountDeletionStatusDto["status"];
  const projection = expectedProjection(status);
  if (
    value.accessState !== projection.accessState ||
    value.canCancel !== projection.canCancel ||
    value.nextAction !== projection.nextAction
  ) {
    throw invalidReceipt();
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
    throw invalidReceipt();
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
    throw invalidReceipt();
  }
  return {
    request: parseStatus(value.request),
    statusCredential: value.statusCredential,
    recoveryCredential: value.recoveryCredential,
  };
}

function capabilityStorageError(cause: unknown): AccountDeletionClientError {
  return new AccountDeletionClientError(
    "This browser cannot durably retain account-deletion recovery authority.",
    {
      code: "ACCOUNT_DELETION_CAPABILITY_STORAGE_UNAVAILABLE",
      cause,
      severity: "fatal",
    },
  );
}

function writeDurableCredential(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(key, value);
    if (window.localStorage.getItem(key) !== value) {
      throw capabilityStorageError("credential round-trip mismatch");
    }
  } catch (cause) {
    // error-policy:J2 losing this capability after the server fences the
    // account would strand cancellation and export, so storage must fail closed.
    if (cause instanceof AccountDeletionClientError) throw cause;
    throw capabilityStorageError(cause);
  }
}

function removeLegacySessionCredential(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // error-policy:J6 the durable copy is authoritative; legacy-session
    // cleanup is best-effort and never changes server capability validity.
  }
}

function readDurableCredential(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const durable = window.localStorage.getItem(key);
    if (durable !== null) return durable;
  } catch (cause) {
    // error-policy:J2 a denied durable store cannot be mistaken for an absent
    // deletion request after immediate session fencing.
    throw capabilityStorageError(cause);
  }

  let legacy: string | null = null;
  try {
    legacy = window.sessionStorage.getItem(key);
  } catch {
    // error-policy:J4 sessionStorage is only a backward-compatibility source;
    // a usable durable store remains the authoritative empty state.
  }
  if (legacy !== null) {
    writeDurableCredential(key, legacy);
    removeLegacySessionCredential(key);
  }
  return legacy;
}

function removeDurableCredential(key: string): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(key);
    if (window.localStorage.getItem(key) !== null) {
      throw capabilityStorageError("credential removal round-trip mismatch");
    }
    removeLegacySessionCredential(key);
  } catch (cause) {
    // error-policy:J2 local retirement must be explicit. Server-side
    // invalidation still prevents a retained consumed capability from working.
    if (cause instanceof AccountDeletionClientError) throw cause;
    throw capabilityStorageError(cause);
  }
}

function createAdmissionCredential(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new AccountDeletionClientError(
      "This browser cannot create secure deletion authority.",
      {
        code: "ACCOUNT_DELETION_SECURE_RANDOM_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const OPAQUE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What this browser holds for one deletion request. */
interface StoredDeletionRequest {
  /** Signed-in user id when the request was made; null for migrated v1 keys. */
  accountId: string | null;
  accountLabel: string | null;
  /** Null until the server's receipt (or a status read) names the request. */
  requestId: string | null;
  admissionCredential: string | null;
  statusCredential: string | null;
  recoveryCredential: string | null;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseStoredRequests(raw: string): StoredDeletionRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J2 an unreadable record may hold live recovery authority, so
    // it is never silently replaced with an empty list.
    throw capabilityStorageError(cause);
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 2 ||
    !Array.isArray(parsed.requests) ||
    !parsed.requests.every(
      (entry) =>
        isRecord(entry) &&
        nullableString(entry.accountId) &&
        nullableString(entry.accountLabel) &&
        nullableString(entry.requestId) &&
        nullableString(entry.admissionCredential) &&
        nullableString(entry.statusCredential) &&
        nullableString(entry.recoveryCredential),
    )
  ) {
    throw capabilityStorageError("malformed account-deletion request record");
  }
  return (parsed.requests as Record<string, unknown>[]).map((entry) => ({
    accountId: entry.accountId as string | null,
    accountLabel: entry.accountLabel as string | null,
    requestId: entry.requestId as string | null,
    admissionCredential: entry.admissionCredential as string | null,
    statusCredential: entry.statusCredential as string | null,
    recoveryCredential: entry.recoveryCredential as string | null,
  }));
}

function writeStoredRequests(requests: StoredDeletionRequest[]): void {
  writeDurableCredential(
    REQUESTS_KEY,
    JSON.stringify({ version: 2, requests }),
  );
}

function loadStoredRequests(): StoredDeletionRequest[] {
  const raw = readDurableCredential(REQUESTS_KEY);
  if (raw !== null) return parseStoredRequests(raw);

  // One-time migration of the v1 single-request keys. The new record is
  // written and verified before the old keys are removed, so a live recovery
  // credential is never lost in between.
  const legacy: StoredDeletionRequest = {
    accountId: null,
    accountLabel: null,
    requestId: null,
    admissionCredential: readDurableCredential(LEGACY_ADMISSION_CREDENTIAL_KEY),
    statusCredential: readDurableCredential(LEGACY_STATUS_CREDENTIAL_KEY),
    recoveryCredential: readDurableCredential(LEGACY_RECOVERY_CREDENTIAL_KEY),
  };
  if (
    !legacy.admissionCredential &&
    !legacy.statusCredential &&
    !legacy.recoveryCredential
  ) {
    return [];
  }
  writeStoredRequests([legacy]);
  removeDurableCredential(LEGACY_ADMISSION_CREDENTIAL_KEY);
  removeDurableCredential(LEGACY_STATUS_CREDENTIAL_KEY);
  removeDurableCredential(LEGACY_RECOVERY_CREDENTIAL_KEY);
  return [legacy];
}

function sameStoredRequest(
  a: StoredDeletionRequest,
  b: StoredDeletionRequest,
): boolean {
  return Boolean(
    (a.requestId && a.requestId === b.requestId) ||
      (a.admissionCredential &&
        a.admissionCredential === b.admissionCredential) ||
      (a.statusCredential && a.statusCredential === b.statusCredential),
  );
}

function isEmptyStoredRequest(entry: StoredDeletionRequest): boolean {
  return (
    !entry.admissionCredential &&
    !entry.statusCredential &&
    !entry.recoveryCredential
  );
}

/** Replaces `previous` with `next` (or removes it when `next` is null). */
function saveStoredRequest(
  previous: StoredDeletionRequest | null,
  next: StoredDeletionRequest | null,
): void {
  const requests = loadStoredRequests().filter(
    (entry) =>
      !(previous && sameStoredRequest(entry, previous)) &&
      !(next && sameStoredRequest(entry, next)),
  );
  if (next && !isEmptyStoredRequest(next)) requests.push(next);
  while (requests.length > MAX_STORED_REQUESTS) {
    // Only an entry without recovery authority may be evicted. Dropping a
    // recovery credential would strand cancel and export for that account.
    const evictable = requests.findIndex(
      (entry) => !entry.recoveryCredential && entry !== next,
    );
    if (evictable < 0) {
      throw new AccountDeletionClientError(
        "This browser already holds recovery access for too many deletion requests. Resolve one on the account-deletion page first.",
        { code: "ACCOUNT_DELETION_CAPABILITY_STORE_FULL", severity: "fatal" },
      );
    }
    requests.splice(evictable, 1);
  }
  writeStoredRequests(requests);
}

function findStoredRequest(requestId: string): StoredDeletionRequest {
  const entry = loadStoredRequests().find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!entry?.recoveryCredential) {
    throw new AccountDeletionClientError(
      "The recovery capability is unavailable in this browser session.",
      {
        code: "ACCOUNT_DELETION_RECOVERY_CAPABILITY_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  return entry;
}

/** The account a deletion request is made for, used to keep requests apart. */
export interface AccountDeletionAccount {
  id: string;
  label: string | null;
}

function getOrCreateAdmissionEntry(
  account: AccountDeletionAccount | null,
): StoredDeletionRequest {
  const accountId = account?.id ?? null;
  const current = loadStoredRequests().find(
    (entry) =>
      entry.accountId === accountId &&
      entry.admissionCredential !== null &&
      OPAQUE_CREDENTIAL_PATTERN.test(entry.admissionCredential),
  );
  if (current) return current;
  const created: StoredDeletionRequest = {
    accountId,
    accountLabel: account?.label || null,
    requestId: null,
    admissionCredential: createAdmissionCredential(),
    statusCredential: null,
    recoveryCredential: null,
  };
  saveStoredRequest(null, created);
  return created;
}

function rememberAccountDeletionCapabilities(
  entry: StoredDeletionRequest,
  accepted: AccountDeletionAcceptedDto,
): StoredDeletionRequest {
  const next: StoredDeletionRequest = {
    ...entry,
    requestId: accepted.request.requestId,
    statusCredential: accepted.statusCredential,
    recoveryCredential: accepted.recoveryCredential,
  };
  saveStoredRequest(entry, next);
  return next;
}

/**
 * Recovers the receipt for an admission credential whose POST outcome was
 * lost. Returns null, and forgets the credential, when the server says no
 * request was ever admitted with it.
 */
async function recoverAccountDeletionCapabilities(
  entry: StoredDeletionRequest,
): Promise<StoredDeletionRequest | null> {
  let accepted: AccountDeletionAcceptedDto;
  try {
    accepted = parseAccepted(
      await api<unknown>("/api/public/account-deletion", {
        method: "POST",
        skipAuth: true,
        json: {
          confirmation: "DELETE",
          admissionCredential: entry.admissionCredential,
        },
      }),
    );
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      cause.code === "ADMISSION_CREDENTIAL_INVALID"
    ) {
      const next = { ...entry, admissionCredential: null };
      saveStoredRequest(entry, next);
      return isEmptyStoredRequest(next) ? null : next;
    }
    throw cause;
  }
  return rememberAccountDeletionCapabilities(entry, accepted);
}

async function activateAccountDeletion(
  entry: StoredDeletionRequest,
): Promise<AccountDeletionStatusDto> {
  const response = await api<unknown>("/api/public/account-deletion", {
    method: "PATCH",
    skipAuth: true,
    headers: {
      "X-Account-Deletion-Recovery": entry.recoveryCredential ?? "",
    },
    json: { confirmation: "ACTIVATE DELETION" },
  });
  const status = parseStatusEnvelope(response);
  if (status.status === "pending_activation") {
    throw new AccountDeletionClientError(
      "Account deletion activation was not acknowledged.",
      {
        code: "ACCOUNT_DELETION_RECEIPT_INVALID",
        severity: "fatal",
      },
    );
  }
  saveStoredRequest(entry, { ...entry, admissionCredential: null });
  return status;
}

export async function submitAccountDeletion(
  account: AccountDeletionAccount | null,
): Promise<AccountDeletionAcceptedDto> {
  // Persist before the destructive request. A network failure leaves this
  // one-time authority available to recover the already-committed receipt.
  const admission = getOrCreateAdmissionEntry(account);
  let accepted: AccountDeletionAcceptedDto;
  try {
    accepted = parseAccepted(
      await api<unknown>("/api/v1/me/account-deletion", {
        method: "POST",
        json: {
          confirmation: "DELETE",
          admissionCredential: admission.admissionCredential,
        },
      }),
    );
  } catch (cause) {
    // A 400 or 409 is answered only after the server found no admitted
    // request for this credential, so nothing exists to recover. A 401, 5xx
    // or network failure may follow a committed request and keeps it. Only
    // the admission credential goes: a saved request keeps its recovery.
    if (
      cause instanceof ApiError &&
      (cause.status === 400 || cause.status === 409)
    ) {
      saveStoredRequest(admission, { ...admission, admissionCredential: null });
    }
    throw cause;
  }
  const entry = rememberAccountDeletionCapabilities(admission, accepted);
  let request: AccountDeletionStatusDto;
  try {
    request = await activateAccountDeletion(entry);
  } catch (cause) {
    throw new AccountDeletionClientError(
      "Your deletion request was saved but not confirmed. Finish it or keep your account on the account-deletion page.",
      {
        code: "ACCOUNT_DELETION_ACTIVATION_PENDING",
        cause,
        severity: "ephemeral",
        requestId: accepted.request.requestId,
      },
    );
  }
  return { ...accepted, request };
}

/** One deletion request this browser can act on, with its server status. */
export interface StoredAccountDeletion {
  accountId: string | null;
  accountLabel: string | null;
  request: AccountDeletionStatusDto;
}

/**
 * Reads the server status of every deletion request saved in this browser.
 * A read never activates a request: one left in pending_activation is
 * returned as is, and only {@link finishAccountDeletion} activates it.
 */
export async function readAccountDeletionStatuses(): Promise<
  StoredAccountDeletion[]
> {
  const results: StoredAccountDeletion[] = [];
  for (const stored of loadStoredRequests()) {
    let entry: StoredDeletionRequest | null = stored;
    if (
      (!entry.statusCredential || !entry.recoveryCredential) &&
      entry.admissionCredential
    ) {
      entry = await recoverAccountDeletionCapabilities(entry);
    }
    if (!entry?.statusCredential) continue;
    let response: unknown;
    try {
      response = await api<unknown>("/api/public/account-deletion", {
        skipAuth: true,
        headers: { "X-Account-Deletion-Status": entry.statusCredential },
      });
    } catch (cause) {
      // An expired status credential with no recovery authority left is a
      // finished request; forget it so it cannot hide the others.
      if (
        cause instanceof ApiError &&
        cause.code === "STATUS_CREDENTIAL_INVALID" &&
        !entry.recoveryCredential
      ) {
        saveStoredRequest(entry, null);
        continue;
      }
      throw cause;
    }
    const request = parseStatusEnvelope(response);
    if (entry.requestId !== request.requestId) {
      saveStoredRequest(entry, { ...entry, requestId: request.requestId });
    }
    results.push({
      accountId: entry.accountId,
      accountLabel: entry.accountLabel,
      request,
    });
  }
  return results;
}

/** Activates a saved pending_activation request after the user confirms. */
export async function finishAccountDeletion(
  requestId: string,
): Promise<AccountDeletionStatusDto> {
  return activateAccountDeletion(findStoredRequest(requestId));
}

/**
 * Forgets a request that never activated. The server keeps it inert in
 * pending_activation and lets the same account replace it later, so the
 * account stays active.
 */
export function abandonAccountDeletion(requestId: string): void {
  const entry = loadStoredRequests().find(
    (candidate) => candidate.requestId === requestId,
  );
  if (entry) saveStoredRequest(entry, null);
}

export async function cancelAccountDeletion(
  requestId: string,
): Promise<AccountDeletionStatusDto> {
  const entry = findStoredRequest(requestId);
  const response = await api<unknown>("/api/public/account-deletion", {
    method: "DELETE",
    skipAuth: true,
    headers: { "X-Account-Deletion-Recovery": entry.recoveryCredential ?? "" },
    json: { confirmation: "CANCEL DELETION" },
  });
  const status = parseStatusEnvelope(response);
  if (status.status === "canceled") {
    saveStoredRequest(entry, { ...entry, recoveryCredential: null });
  }
  return status;
}

export interface AccountDeletionExportDownload {
  blob: Blob;
  contentDigest: string;
  filename: string;
}

export async function downloadAccountDeletionExport(
  requestId: string,
): Promise<AccountDeletionExportDownload> {
  const entry = findStoredRequest(requestId);
  const response = await apiFetch("/api/public/account-deletion/export", {
    method: "POST",
    skipAuth: true,
    headers: { "X-Account-Deletion-Recovery": entry.recoveryCredential ?? "" },
    json: { confirmation: "EXPORT MY DATA" },
  });
  return readVerifiedExportDownload(response, "deletion export");
}

/**
 * Reads a portable account export response and verifies its bytes against
 * the server's `X-Account-Deletion-Export-SHA256` receipt. Shared by the
 * recovery-window export and the live-account data export, which return the
 * same response shape.
 */
export async function readVerifiedExportDownload(
  response: Response,
  label: string,
): Promise<AccountDeletionExportDownload> {
  const contentDigest =
    response.headers.get("X-Account-Deletion-Export-SHA256") ?? "";
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) {
    throw new AccountDeletionClientError(
      `The ${label} response has no valid content digest.`,
      {
        code: "ACCOUNT_DELETION_EXPORT_DIGEST_INVALID",
        severity: "fatal",
      },
    );
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filenameMatch = /filename="([A-Za-z0-9._-]+)"/.exec(disposition);
  const blob = await response.blob();
  if (!globalThis.crypto?.subtle) {
    throw new AccountDeletionClientError(
      `This browser cannot verify the ${label} digest.`,
      {
        code: "ACCOUNT_DELETION_EXPORT_CRYPTO_UNAVAILABLE",
        severity: "fatal",
      },
    );
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
    throw new AccountDeletionClientError(
      `The ${label} bytes do not match the server receipt.`,
      {
        code: "ACCOUNT_DELETION_EXPORT_DIGEST_MISMATCH",
        severity: "fatal",
      },
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
