/**
 * Owns the remote target's stable device identity, host bearer, and private
 * P-256 keys in the operating-system credential service. Only public identity
 * data can leave this module.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  canonicalizeRemoteControlValue,
  isRemoteTargetPublicIdentity,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteTargetPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import { resolveCanonicalStateDir } from "../../../src/security/agent-vault-id";
import type { PlatformSecureStore } from "../../../src/security/platform-secure-store";
import { createNodePlatformSecureStore } from "../../../src/security/platform-secure-store-node";

const TARGET_VAULT_KIND = "runtime.agent_profiles" as const;
const HOST_TOKEN_PATTERN = /^rhost_v1_[A-Za-z0-9_-]{43}$/;

export interface PendingRemoteTargetVaultRecord {
  version: 1;
  status: "pending";
  ownerId: string;
  deviceId: string;
  displayName: string;
  keyId: string;
  signingPrivateKeyJwk: JsonWebKey;
  encryptionPrivateKeyJwk: JsonWebKey;
  createdAt: number;
}

export interface EnrolledRemoteTargetVaultRecord {
  version: 1;
  status: "enrolled";
  apiBaseUrl: string;
  hostToken: string;
  identity: RemoteTargetPublicIdentity;
  deviceId: string;
  signingPrivateKeyJwk: JsonWebKey;
  encryptionPrivateKeyJwk: JsonWebKey;
  managedNetwork?: {
    hostname: string;
  };
}

type RemoteTargetVaultRecord =
  | PendingRemoteTargetVaultRecord
  | EnrolledRemoteTargetVaultRecord;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function isPrivateP256Jwk(value: unknown): value is JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    Reflect.get(value, "kty") === "EC" &&
    Reflect.get(value, "crv") === "P-256" &&
    typeof Reflect.get(value, "x") === "string" &&
    typeof Reflect.get(value, "y") === "string" &&
    typeof Reflect.get(value, "d") === "string"
  );
}

function publicJwk(privateKey: JsonWebKey): JsonWebKey {
  const { d: _privateScalar, ...publicFields } = privateKey;
  return publicFields;
}

function generatePrivateP256Jwk(): JsonWebKey {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ format: "jwk" });
}

function keyId(signing: JsonWebKey, encryption: JsonWebKey): string {
  return `p256:${createHash("sha256")
    .update(
      canonicalizeRemoteControlValue({
        signingPublicKeyJwk: publicJwk(signing),
        encryptionPublicKeyJwk: publicJwk(encryption),
      }),
    )
    .digest("base64url")}`;
}

function canonicalApiBase(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Stored remote target API URL is invalid.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isManagedNetworkRecord(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "hostname") === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      Reflect.get(value, "hostname") as string,
    )
  );
}

export function remoteTargetVaultId(
  canonicalStateDir = resolveCanonicalStateDir(),
): string {
  return `remote-target-${createHash("sha256")
    .update(`linux-target-v1\0${canonicalStateDir}`)
    .digest("hex")}`;
}

function parseRecord(raw: string): RemoteTargetVaultRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 OS credential-store contents are untrusted input.
    throw new Error("Stored remote target identity is corrupt.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.get(value, "version") !== 1 ||
    !isPrivateP256Jwk(Reflect.get(value, "signingPrivateKeyJwk")) ||
    !isPrivateP256Jwk(Reflect.get(value, "encryptionPrivateKeyJwk"))
  ) {
    throw new Error("Stored remote target identity is corrupt.");
  }
  if (Reflect.get(value, "status") === "pending") {
    const signingPrivateKeyJwk = Reflect.get(
      value,
      "signingPrivateKeyJwk",
    ) as JsonWebKey;
    const encryptionPrivateKeyJwk = Reflect.get(
      value,
      "encryptionPrivateKeyJwk",
    ) as JsonWebKey;
    if (
      !isIdentifier(Reflect.get(value, "ownerId")) ||
      !isIdentifier(Reflect.get(value, "deviceId")) ||
      !isIdentifier(Reflect.get(value, "keyId")) ||
      typeof Reflect.get(value, "displayName") !== "string" ||
      (Reflect.get(value, "displayName") as string).trim().length === 0 ||
      (Reflect.get(value, "displayName") as string) !==
        (Reflect.get(value, "displayName") as string).trim() ||
      Buffer.byteLength(Reflect.get(value, "displayName") as string, "utf8") >
        128 ||
      Reflect.get(value, "keyId") !==
        keyId(signingPrivateKeyJwk, encryptionPrivateKeyJwk) ||
      !Number.isSafeInteger(Reflect.get(value, "createdAt"))
    ) {
      throw new Error("Stored remote target identity is corrupt.");
    }
    return value as PendingRemoteTargetVaultRecord;
  }
  if (
    Reflect.get(value, "status") !== "enrolled" ||
    !isIdentifier(Reflect.get(value, "deviceId")) ||
    typeof Reflect.get(value, "apiBaseUrl") !== "string" ||
    typeof Reflect.get(value, "hostToken") !== "string" ||
    !HOST_TOKEN_PATTERN.test(Reflect.get(value, "hostToken") as string) ||
    !isRemoteTargetPublicIdentity(Reflect.get(value, "identity")) ||
    !isManagedNetworkRecord(Reflect.get(value, "managedNetwork"))
  ) {
    throw new Error("Stored remote target identity is corrupt.");
  }
  const enrolled = value as EnrolledRemoteTargetVaultRecord;
  const expectedSigning = publicJwk(enrolled.signingPrivateKeyJwk);
  const expectedEncryption = publicJwk(enrolled.encryptionPrivateKeyJwk);
  if (
    enrolled.identity.keyId !==
      keyId(enrolled.signingPrivateKeyJwk, enrolled.encryptionPrivateKeyJwk) ||
    canonicalizeRemoteControlValue(enrolled.identity.signingPublicKeyJwk) !==
      canonicalizeRemoteControlValue(expectedSigning) ||
    canonicalizeRemoteControlValue(enrolled.identity.encryptionPublicKeyJwk) !==
      canonicalizeRemoteControlValue(expectedEncryption) ||
    canonicalApiBase(enrolled.apiBaseUrl) !== enrolled.apiBaseUrl
  ) {
    throw new Error("Stored remote target identity is corrupt.");
  }
  return enrolled;
}

export class RemoteTargetVault {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly secureStore: PlatformSecureStore = createNodePlatformSecureStore(),
    private readonly vaultId = remoteTargetVaultId(),
  ) {}

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.mutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // error-policy:J5 the failed vault mutation's caller observes its rejection;
    // this tail suppression only keeps later serialized mutations reachable.
    this.mutationTail = predecessor.catch(() => undefined).then(() => current);
    // error-policy:J5 the originating mutation caller observes the same
    // predecessor rejection; this waiter only preserves queue ordering.
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async load(): Promise<RemoteTargetVaultRecord | null> {
    const result = await this.secureStore.get(this.vaultId, TARGET_VAULT_KIND);
    if (!result.ok) {
      if (result.reason === "not_found") return null;
      throw new Error("Secure remote target storage is unavailable.");
    }
    return parseRecord(result.value);
  }

  async prepare(input: {
    ownerId: string;
    displayName: string;
    now: number;
  }): Promise<
    PendingRemoteTargetVaultRecord | EnrolledRemoteTargetVaultRecord
  > {
    if (
      !isIdentifier(input.ownerId) ||
      input.displayName.trim().length === 0 ||
      input.displayName.trim().length > 128
    ) {
      throw new Error("Remote target identity fields are invalid.");
    }
    return this.serialize(async () => {
      const existing = await this.load();
      if (existing) {
        const existingOwner =
          existing.status === "enrolled"
            ? existing.identity.ownerId
            : existing.ownerId;
        if (existingOwner !== input.ownerId) {
          throw new Error("Remote target is enrolled to a different owner.");
        }
        return existing;
      }
      const signingPrivateKeyJwk = generatePrivateP256Jwk();
      const encryptionPrivateKeyJwk = generatePrivateP256Jwk();
      const pending: PendingRemoteTargetVaultRecord = {
        version: 1,
        status: "pending",
        ownerId: input.ownerId,
        deviceId: randomUUID(),
        displayName: input.displayName.trim(),
        keyId: keyId(signingPrivateKeyJwk, encryptionPrivateKeyJwk),
        signingPrivateKeyJwk,
        encryptionPrivateKeyJwk,
        createdAt: input.now,
      };
      const stored = await this.secureStore.set(
        this.vaultId,
        TARGET_VAULT_KIND,
        JSON.stringify(pending),
      );
      if (!stored.ok) {
        throw new Error("Secure remote target storage is unavailable.");
      }
      return pending;
    });
  }

  async commitEnrollment(input: {
    apiBaseUrl: string;
    hostId: string;
    hostToken: string;
    runtimeKeyId: string;
    createdAt: number;
  }): Promise<EnrolledRemoteTargetVaultRecord> {
    return this.serialize(async () => {
      const existing = await this.load();
      if (!existing) throw new Error("Remote target identity is missing.");
      if (existing.status === "enrolled") {
        if (
          existing.identity.runtimeId !== input.hostId ||
          existing.hostToken !== input.hostToken
        ) {
          throw new Error(
            "Remote target enrollment conflicts with stored state.",
          );
        }
        return existing;
      }
      if (
        !isIdentifier(input.hostId) ||
        !HOST_TOKEN_PATTERN.test(input.hostToken) ||
        input.runtimeKeyId !== existing.keyId ||
        !Number.isSafeInteger(input.createdAt) ||
        input.createdAt <= 0
      ) {
        throw new Error("Remote target enrollment response is invalid.");
      }
      const identity: RemoteTargetPublicIdentity = {
        version: REMOTE_CONTROL_PROTOCOL_VERSION,
        role: "target",
        ownerId: existing.ownerId,
        runtimeId: input.hostId,
        keyId: existing.keyId,
        displayName: existing.displayName,
        platform: "linux",
        signingPublicKeyJwk: publicJwk(existing.signingPrivateKeyJwk),
        encryptionPublicKeyJwk: publicJwk(existing.encryptionPrivateKeyJwk),
        createdAt: input.createdAt,
      };
      const enrolled: EnrolledRemoteTargetVaultRecord = {
        version: 1,
        status: "enrolled",
        apiBaseUrl: input.apiBaseUrl,
        hostToken: input.hostToken,
        identity,
        deviceId: existing.deviceId,
        signingPrivateKeyJwk: existing.signingPrivateKeyJwk,
        encryptionPrivateKeyJwk: existing.encryptionPrivateKeyJwk,
      };
      const stored = await this.secureStore.set(
        this.vaultId,
        TARGET_VAULT_KIND,
        JSON.stringify(enrolled),
      );
      if (!stored.ok) {
        throw new Error("Secure remote target storage is unavailable.");
      }
      return enrolled;
    });
  }

  async recordManagedNetwork(input: {
    hostId: string;
    hostname: string;
  }): Promise<EnrolledRemoteTargetVaultRecord> {
    if (
      !isIdentifier(input.hostId) ||
      !isManagedNetworkRecord({ hostname: input.hostname })
    ) {
      throw new Error("Managed network identity is invalid.");
    }
    return this.serialize(async () => {
      const existing = await this.load();
      if (
        existing?.status !== "enrolled" ||
        existing.identity.runtimeId !== input.hostId
      ) {
        throw new Error(
          "Managed network enrollment does not match stored state.",
        );
      }
      const updated: EnrolledRemoteTargetVaultRecord = {
        ...existing,
        managedNetwork: { hostname: input.hostname },
      };
      const stored = await this.secureStore.set(
        this.vaultId,
        TARGET_VAULT_KIND,
        JSON.stringify(updated),
      );
      if (!stored.ok) {
        throw new Error("Secure remote target storage is unavailable.");
      }
      return updated;
    });
  }

  async delete(): Promise<boolean> {
    return this.serialize(async () => {
      const result = await this.secureStore.delete(
        this.vaultId,
        TARGET_VAULT_KIND,
      );
      if (!result.ok && result.reason !== "not_found") {
        throw new Error("Secure remote target deletion failed.");
      }
      return result.ok ? result.deleted : false;
    });
  }
}

export const remoteTargetVaultInternals = {
  HOST_TOKEN_PATTERN,
  keyId,
  parseRecord,
  publicJwk,
  canonicalApiBase,
};
