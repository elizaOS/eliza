/**
 * Stores a bounded, device-local hint that an email has completed passkey use.
 *
 * The hint is advisory: it chooses between scoped passkey authentication and
 * email-verified enrollment without asking Steward whether an account exists.
 * Emails are normalized and HMACed with a random device-local key so browser
 * storage never contains the address in plaintext or a cross-device digest.
 */

export const PASSKEY_DEVICE_HINT_STORAGE_KEY = "eliza:passkey-device-hints:v1";

const PASSKEY_DEVICE_HINT_VERSION = 1;
const PASSKEY_DEVICE_HINT_LIMIT = 16;
const PASSKEY_DEVICE_HINT_KEY_BYTES = 32;

type PasskeyDeviceHintRecord = {
  version: typeof PASSKEY_DEVICE_HINT_VERSION;
  key: string;
  hints: string[];
};

type PasskeyDeviceHintStorage = Pick<Storage, "getItem" | "setItem">;

export type PasskeyDeviceHintEnvironment = {
  storage: PasskeyDeviceHintStorage;
  crypto: Crypto;
};

type ReadRecordResult =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ready"; record: PasskeyDeviceHintRecord };

export function normalizePasskeyHintEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

function resolveDefaultEnvironment(): PasskeyDeviceHintEnvironment | null {
  if (
    typeof globalThis === "undefined" ||
    !globalThis.crypto?.subtle ||
    typeof globalThis.localStorage === "undefined"
  ) {
    return null;
  }

  try {
    return { storage: globalThis.localStorage, crypto: globalThis.crypto };
  } catch {
    // error-policy:J4 storage-denied browsers safely take the enrollment path;
    // the server is never queried for account existence as a fallback.
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Passkey hint key is not base64url");
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isHintDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readRecord(storage: PasskeyDeviceHintStorage): ReadRecordResult {
  let raw: string | null;
  try {
    raw = storage.getItem(PASSKEY_DEVICE_HINT_STORAGE_KEY);
  } catch {
    // error-policy:J4 storage failure degrades to enrollment without revealing
    // whether Steward has an account or passkey for the entered email.
    return { kind: "missing" };
  }
  if (raw === null) return { kind: "missing" };

  try {
    const candidate: unknown = JSON.parse(raw);
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return { kind: "invalid" };
    }
    const record = candidate as Record<string, unknown>;
    if (
      record.version !== PASSKEY_DEVICE_HINT_VERSION ||
      typeof record.key !== "string" ||
      !Array.isArray(record.hints) ||
      record.hints.length > PASSKEY_DEVICE_HINT_LIMIT ||
      !record.hints.every(isHintDigest) ||
      new Set(record.hints).size !== record.hints.length ||
      base64UrlToBytes(record.key).length !== PASSKEY_DEVICE_HINT_KEY_BYTES
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "ready",
      record: {
        version: PASSKEY_DEVICE_HINT_VERSION,
        key: record.key,
        hints: record.hints,
      },
    };
  } catch {
    // error-policy:J3 browser storage is untrusted input; malformed records
    // become an explicit invalid state and are replaced only by a later mark.
    return { kind: "invalid" };
  }
}

async function hashEmail(
  normalizedEmail: string,
  key: Uint8Array,
  crypto: Crypto,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    copyToArrayBuffer(new TextEncoder().encode(normalizedEmail)),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function hasPasskeyDeviceHint(
  email: string,
  environment: PasskeyDeviceHintEnvironment | null = resolveDefaultEnvironment(),
): Promise<boolean> {
  const normalizedEmail = normalizePasskeyHintEmail(email);
  if (!normalizedEmail || !environment) return false;

  const result = readRecord(environment.storage);
  if (result.kind !== "ready") return false;

  try {
    const digest = await hashEmail(
      normalizedEmail,
      base64UrlToBytes(result.record.key),
      environment.crypto,
    );
    return result.record.hints.includes(digest);
  } catch {
    // error-policy:J4 unavailable Web Crypto safely routes through verified
    // enrollment instead of falling back to a server-side existence check.
    return false;
  }
}

export async function rememberPasskeyDeviceHint(
  email: string,
  environment: PasskeyDeviceHintEnvironment | null = resolveDefaultEnvironment(),
): Promise<boolean> {
  const normalizedEmail = normalizePasskeyHintEmail(email);
  if (!normalizedEmail || !environment) return false;

  try {
    const result = readRecord(environment.storage);
    const key =
      result.kind === "ready"
        ? base64UrlToBytes(result.record.key)
        : environment.crypto.getRandomValues(
            new Uint8Array(PASSKEY_DEVICE_HINT_KEY_BYTES),
          );
    const digest = await hashEmail(normalizedEmail, key, environment.crypto);
    const previousHints = result.kind === "ready" ? result.record.hints : [];
    const hints = [
      ...previousHints.filter((hint) => hint !== digest),
      digest,
    ].slice(-PASSKEY_DEVICE_HINT_LIMIT);
    const record: PasskeyDeviceHintRecord = {
      version: PASSKEY_DEVICE_HINT_VERSION,
      key: bytesToBase64Url(key),
      hints,
    };
    environment.storage.setItem(
      PASSKEY_DEVICE_HINT_STORAGE_KEY,
      JSON.stringify(record),
    );
    return true;
  } catch {
    // error-policy:J4 hint persistence is an optional UX optimization. A
    // successful authentication remains successful when storage is denied.
    return false;
  }
}
