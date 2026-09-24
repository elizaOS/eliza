/**
 * Stores per-runtime access tokens and approved SSH host fingerprints in the
 * operating system credential service. Renderer callers receive only the
 * requested value; private controller keys and bearer tokens never enter
 * browser persistence through this boundary.
 */
import { createHash } from "node:crypto";

import type { PlatformSecureStore } from "../../../src/security/platform-secure-store";
import { createNodePlatformSecureStore } from "../../../src/security/platform-secure-store-node";

const RUNTIME_CREDENTIAL_RECORD_VERSION = 1 as const;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const SSH_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_ACCESS_TOKEN_BYTES = 64 * 1024;

interface RuntimeCredentialRecord {
  version: typeof RUNTIME_CREDENTIAL_RECORD_VERSION;
  accessToken?: string;
  sshHostFingerprint?: string;
}

export interface RuntimeCredentialSnapshot {
  accessToken: string | null;
  sshHostFingerprint: string | null;
}

const nativeStore = createNodePlatformSecureStore();
const mutationTails = new Map<string, Promise<void>>();

function requireRuntimeId(value: unknown): string {
  if (typeof value !== "string" || !RUNTIME_ID_PATTERN.test(value.trim())) {
    throw new Error("Runtime id is invalid.");
  }
  return value.trim();
}

function credentialVaultId(runtimeId: string): string {
  const digest = createHash("sha256").update(runtimeId).digest("hex");
  return `remote-runtime-${digest}`;
}

function parseRecord(value: string): RuntimeCredentialRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // error-policy:J3 native credential-store contents are untrusted input.
    throw new Error("Stored runtime credential is corrupt.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored runtime credential is corrupt.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== RUNTIME_CREDENTIAL_RECORD_VERSION ||
    (record.accessToken !== undefined &&
      (typeof record.accessToken !== "string" ||
        record.accessToken.length === 0 ||
        Buffer.byteLength(record.accessToken, "utf8") >
          MAX_ACCESS_TOKEN_BYTES)) ||
    (record.sshHostFingerprint !== undefined &&
      (typeof record.sshHostFingerprint !== "string" ||
        !SSH_FINGERPRINT_PATTERN.test(record.sshHostFingerprint)))
  ) {
    throw new Error("Stored runtime credential is corrupt.");
  }
  return {
    version: RUNTIME_CREDENTIAL_RECORD_VERSION,
    ...(typeof record.accessToken === "string"
      ? { accessToken: record.accessToken }
      : {}),
    ...(typeof record.sshHostFingerprint === "string"
      ? { sshHostFingerprint: record.sshHostFingerprint }
      : {}),
  };
}

async function loadRecord(
  store: PlatformSecureStore,
  runtimeId: string,
): Promise<RuntimeCredentialRecord> {
  const result = await store.get(
    credentialVaultId(runtimeId),
    "runtime.access_token",
  );
  if (!result.ok) {
    if (result.reason === "not_found") {
      return { version: RUNTIME_CREDENTIAL_RECORD_VERSION };
    }
    throw new Error(
      result.reason === "denied"
        ? "The operating system denied credential access."
        : "Secure credential storage is unavailable.",
    );
  }
  return parseRecord(result.value);
}

async function saveRecord(
  store: PlatformSecureStore,
  runtimeId: string,
  record: RuntimeCredentialRecord,
): Promise<void> {
  const vaultId = credentialVaultId(runtimeId);
  if (!record.accessToken && !record.sshHostFingerprint) {
    const result = await store.delete(vaultId, "runtime.access_token");
    if (!result.ok && result.reason !== "not_found") {
      throw new Error("Secure credential deletion failed.");
    }
    return;
  }
  const result = await store.set(
    vaultId,
    "runtime.access_token",
    JSON.stringify(record),
  );
  if (!result.ok) {
    throw new Error(
      result.reason === "denied"
        ? "The operating system denied credential storage."
        : "Secure credential storage is unavailable.",
    );
  }
}

async function mutateRecord<T>(
  store: PlatformSecureStore,
  runtimeId: string,
  mutation: (record: RuntimeCredentialRecord) => T | Promise<T>,
): Promise<T> {
  const predecessor = mutationTails.get(runtimeId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // error-policy:J5 the failed credential mutation's caller observes its
  // rejection; this queue tail only preserves later mutation progress.
  const queued = predecessor.catch(() => undefined).then(() => current);
  mutationTails.set(runtimeId, queued);
  // error-policy:J5 the originating mutation caller observes the same
  // predecessor rejection; this waiter only preserves queue ordering.
  await predecessor.catch(() => undefined);
  try {
    const record = await loadRecord(store, runtimeId);
    const result = await mutation(record);
    await saveRecord(store, runtimeId, record);
    return result;
  } finally {
    release();
    if (mutationTails.get(runtimeId) === queued)
      mutationTails.delete(runtimeId);
  }
}

export async function readRuntimeCredentialSnapshot(
  runtimeIdValue: unknown,
  store: PlatformSecureStore = nativeStore,
): Promise<RuntimeCredentialSnapshot> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  const record = await loadRecord(store, runtimeId);
  return {
    accessToken: record.accessToken ?? null,
    sshHostFingerprint: record.sshHostFingerprint ?? null,
  };
}

export async function desktopStoreRuntimeCredential(
  params: unknown,
  store: PlatformSecureStore = nativeStore,
): Promise<{ stored: true }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Runtime credential parameters are required.");
  }
  const runtimeId = requireRuntimeId(Reflect.get(params, "runtimeId"));
  const value = Reflect.get(params, "accessToken");
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ACCESS_TOKEN_BYTES
  ) {
    throw new Error("Runtime access token is missing or too large.");
  }
  await mutateRecord(store, runtimeId, (record) => {
    record.accessToken = value.trim();
  });
  return { stored: true };
}

export async function desktopLoadRuntimeCredential(
  params: unknown,
  store: PlatformSecureStore = nativeStore,
): Promise<{ accessToken: string | null }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Runtime credential parameters are required.");
  }
  const snapshot = await readRuntimeCredentialSnapshot(
    Reflect.get(params, "runtimeId"),
    store,
  );
  return { accessToken: snapshot.accessToken };
}

export async function desktopDeleteRuntimeCredential(
  params: unknown,
  store: PlatformSecureStore = nativeStore,
): Promise<{ deleted: boolean }> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Runtime credential parameters are required.");
  }
  const runtimeId = requireRuntimeId(Reflect.get(params, "runtimeId"));
  let deleted = false;
  await mutateRecord(store, runtimeId, (record) => {
    deleted = typeof record.accessToken === "string";
    delete record.accessToken;
  });
  return { deleted };
}

export async function storeSshHostFingerprint(
  runtimeIdValue: unknown,
  fingerprintValue: unknown,
  store: PlatformSecureStore = nativeStore,
): Promise<void> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  if (
    typeof fingerprintValue !== "string" ||
    !SSH_FINGERPRINT_PATTERN.test(fingerprintValue)
  ) {
    throw new Error("SSH host fingerprint is invalid.");
  }
  await mutateRecord(store, runtimeId, (record) => {
    record.sshHostFingerprint = fingerprintValue;
  });
}

export async function deleteRuntimeCredentialRecord(
  runtimeIdValue: unknown,
  store: PlatformSecureStore = nativeStore,
): Promise<void> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  const result = await store.delete(
    credentialVaultId(runtimeId),
    "runtime.access_token",
  );
  if (!result.ok && result.reason !== "not_found") {
    throw new Error("Secure credential deletion failed.");
  }
}

export const runtimeCredentialInternals = {
  credentialVaultId,
  parseRecord,
  requireRuntimeId,
};
