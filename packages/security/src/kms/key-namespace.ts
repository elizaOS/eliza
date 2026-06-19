import type { KeyId, KeyVersion } from "./types.js";
import { KmsError } from "./types.js";

export type KeyScope = "system" | "org" | "user";

export interface SystemKeyParts {
  scope: "system";
  purpose: string;
  version: KeyVersion;
}

export interface OrgKeyParts {
  scope: "org";
  orgId: string;
  purpose: "dek" | "hmac";
  version: KeyVersion;
}

export interface UserKeyParts {
  scope: "user";
  userId: string;
  purpose: "connector";
  version: KeyVersion;
}

export type KeyParts = SystemKeyParts | OrgKeyParts | UserKeyParts;

const ID_RE = /^[A-Za-z0-9_\-.]+$/;
const PURPOSE_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertId(value: string, label: string): void {
  if (!ID_RE.test(value)) {
    throw new KmsError(`invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function assertPurpose(value: string): void {
  if (!PURPOSE_RE.test(value)) {
    throw new KmsError(`invalid purpose: ${JSON.stringify(value)}`);
  }
}

function assertVersion(version: KeyVersion): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new KmsError(`invalid key version: ${version}`);
  }
}

export function systemKey(purpose: string, version: KeyVersion = 1): KeyId {
  assertPurpose(purpose);
  assertVersion(version);
  return `system:${purpose}/v${version}`;
}

export function orgKey(
  orgId: string,
  purpose: "dek" | "hmac",
  version: KeyVersion = 1,
): KeyId {
  assertId(orgId, "org_id");
  assertVersion(version);
  return `org:${orgId}/${purpose}/v${version}`;
}

export function userKey(
  userId: string,
  purpose: "connector",
  version: KeyVersion = 1,
): KeyId {
  assertId(userId, "user_id");
  assertVersion(version);
  return `user:${userId}/${purpose}/v${version}`;
}

const KEY_RE =
  /^(system|org|user):([A-Za-z0-9_\-.]+)(?:\/([a-z0-9][a-z0-9-]*))?\/v(\d+)$/;

export function parseKeyId(id: KeyId): KeyParts {
  const match = KEY_RE.exec(id);
  if (!match) throw new KmsError(`malformed key id: ${id}`);
  const scope = match[1] as KeyScope;
  const principal = match[2];
  if (!principal) throw new KmsError(`malformed key id: ${id}`);
  const sub = match[3];
  const version = Number(match[4]);
  assertVersion(version);
  if (scope === "system") {
    if (sub !== undefined) {
      throw new KmsError(`malformed system key id: ${id}`);
    }
    return { scope: "system", purpose: principal, version };
  }
  if (scope === "org") {
    if (sub !== "dek" && sub !== "hmac") {
      throw new KmsError(`malformed org key id: ${id}`);
    }
    return { scope: "org", orgId: principal, purpose: sub, version };
  }
  if (sub !== "connector") {
    throw new KmsError(`malformed user key id: ${id}`);
  }
  return { scope: "user", userId: principal, purpose: sub, version };
}

export function isValidKeyId(id: string): id is KeyId {
  try {
    parseKeyId(id);
    return true;
  } catch {
    return false;
  }
}

export function withVersion(id: KeyId, version: KeyVersion): KeyId {
  parseKeyId(id);
  assertVersion(version);
  return id.replace(/\/v\d+$/, `/v${version}`);
}

export function baseKeyId(id: KeyId): string {
  parseKeyId(id);
  return id.replace(/\/v\d+$/, "");
}
