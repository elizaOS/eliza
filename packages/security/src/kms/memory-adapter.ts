/**
 * In-process KMS adapter for tests and development that keeps key versions in memory.
 */

import {
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { aeadDecrypt, aeadEncrypt } from "../crypto/aead.js";
import { parseKeyId } from "./key-namespace.js";
import {
  type EncryptResult,
  type GetOrCreateKeyOptions,
  type KeyHandle,
  type KeyId,
  KeyNotFoundError,
  type KeyVersion,
  type KmsClient,
  KmsError,
  type SignatureAlgorithm,
  type SignResult,
} from "./types.js";

interface SymVersion {
  version: KeyVersion;
  key: Uint8Array; // 32 bytes
  createdAt: number;
}

interface SignKeyPair {
  algorithm: SignatureAlgorithm;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicRaw: Uint8Array;
}

interface SignVersion {
  version: KeyVersion;
  pairs: Map<SignatureAlgorithm, SignKeyPair>;
  createdAt: number;
}

interface KeyEntry {
  sym: Map<KeyVersion, SymVersion>;
  sig: Map<KeyVersion, SignVersion>;
  currentVersion: KeyVersion;
}

function generateSignPair(algorithm: SignatureAlgorithm): SignKeyPair {
  if (algorithm === "ed25519") {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicRaw = publicKey.export({ format: "der", type: "spki" });
    return {
      algorithm,
      privateKey,
      publicKey,
      publicRaw: new Uint8Array(publicRaw),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
  });
  const publicRaw = publicKey.export({ format: "der", type: "spki" });
  return {
    algorithm,
    privateKey,
    publicKey,
    publicRaw: new Uint8Array(publicRaw),
  };
}

export interface MemoryKmsOptions {
  /** Deterministic key material (test-fixtures only). */
  seed?: () => Uint8Array;
}

export class MemoryKmsAdapter implements KmsClient {
  private readonly keys = new Map<KeyId, KeyEntry>();
  private readonly seed: (() => Uint8Array) | undefined;

  constructor(opts: MemoryKmsOptions = {}) {
    this.seed = opts.seed;
  }

  private materialize(): Uint8Array {
    return this.seed ? this.seed() : new Uint8Array(randomBytes(32));
  }

  private ensureEntry(keyId: KeyId): KeyEntry {
    parseKeyId(keyId);
    let entry = this.keys.get(keyId);
    if (!entry) {
      entry = {
        sym: new Map(),
        sig: new Map(),
        currentVersion: 1,
      };
      const symKey = this.materialize();
      entry.sym.set(1, { version: 1, key: symKey, createdAt: Date.now() });
      entry.sig.set(1, {
        version: 1,
        pairs: new Map(),
        createdAt: Date.now(),
      });
      this.keys.set(keyId, entry);
    }
    return entry;
  }

  private requireEntry(keyId: KeyId): KeyEntry {
    parseKeyId(keyId);
    const e = this.keys.get(keyId);
    if (!e) throw new KeyNotFoundError(keyId);
    return e;
  }

  async getOrCreateKey(
    keyId: KeyId,
    _opts: GetOrCreateKeyOptions = {},
  ): Promise<KeyHandle> {
    const entry = this.ensureEntry(keyId);
    return { keyId, version: entry.currentVersion };
  }

  async rotateKey(
    keyId: KeyId,
  ): Promise<{ keyId: KeyId; newVersion: KeyVersion }> {
    const entry = this.ensureEntry(keyId);
    const newVersion = entry.currentVersion + 1;
    entry.sym.set(newVersion, {
      version: newVersion,
      key: this.materialize(),
      createdAt: Date.now(),
    });
    entry.sig.set(newVersion, {
      version: newVersion,
      pairs: new Map(),
      createdAt: Date.now(),
    });
    entry.currentVersion = newVersion;
    return { keyId, newVersion };
  }

  async listKeyVersions(keyId: KeyId): Promise<KeyVersion[]> {
    const entry = this.requireEntry(keyId);
    return [...entry.sym.keys()].sort((a, b) => a - b);
  }

  async encrypt(
    keyId: KeyId,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<EncryptResult> {
    const entry = this.ensureEntry(keyId);
    const ver = entry.sym.get(entry.currentVersion);
    if (!ver) throw new KeyNotFoundError(keyId, entry.currentVersion);
    const out = aeadEncrypt(ver.key, plaintext, aad);
    return { ...out, keyId, keyVersion: ver.version };
  }

  async decrypt(
    keyId: KeyId,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    authTag: Uint8Array,
    aad?: Uint8Array,
    keyVersion?: KeyVersion,
  ): Promise<Uint8Array> {
    const entry = this.requireEntry(keyId);
    const version = keyVersion ?? entry.currentVersion;
    const ver = entry.sym.get(version);
    if (!ver) throw new KeyNotFoundError(keyId, version);
    return aeadDecrypt(ver.key, ciphertext, nonce, authTag, aad);
  }

  async hmac(keyId: KeyId, data: Uint8Array): Promise<Uint8Array> {
    const entry = this.ensureEntry(keyId);
    const ver = entry.sym.get(entry.currentVersion);
    if (!ver) throw new KeyNotFoundError(keyId, entry.currentVersion);
    const mac = createHmac("sha256", Buffer.from(ver.key))
      .update(Buffer.from(data))
      .digest();
    return new Uint8Array(mac);
  }

  async hmacVerify(
    keyId: KeyId,
    data: Uint8Array,
    tag: Uint8Array,
  ): Promise<boolean> {
    const entry = this.requireEntry(keyId);
    for (const ver of entry.sym.values()) {
      const expected = createHmac("sha256", Buffer.from(ver.key))
        .update(Buffer.from(data))
        .digest();
      if (expected.length === tag.length) {
        try {
          if (timingSafeEqual(expected, Buffer.from(tag))) return true;
        } catch {
          // length mismatch
        }
      }
    }
    return false;
  }

  private ensureSignPair(
    keyId: KeyId,
    version: KeyVersion,
    algorithm: SignatureAlgorithm,
  ): SignKeyPair {
    const entry = this.ensureEntry(keyId);
    let sigVer = entry.sig.get(version);
    if (!sigVer) {
      sigVer = { version, pairs: new Map(), createdAt: Date.now() };
      entry.sig.set(version, sigVer);
    }
    let pair = sigVer.pairs.get(algorithm);
    if (!pair) {
      pair = generateSignPair(algorithm);
      sigVer.pairs.set(algorithm, pair);
    }
    return pair;
  }

  async sign(
    keyId: KeyId,
    data: Uint8Array,
    algo: SignatureAlgorithm = "ed25519",
  ): Promise<SignResult> {
    const entry = this.ensureEntry(keyId);
    const version = entry.currentVersion;
    const pair = this.ensureSignPair(keyId, version, algo);
    const signature =
      algo === "ed25519"
        ? nodeSign(null, Buffer.from(data), pair.privateKey)
        : nodeSign("sha256", Buffer.from(data), {
            key: pair.privateKey,
            padding: 6, // RSA_PKCS1_PSS_PADDING
            saltLength: 32,
          });
    return {
      signature: new Uint8Array(signature),
      algorithm: algo,
      keyId,
      keyVersion: version,
    };
  }

  async verify(
    keyId: KeyId,
    data: Uint8Array,
    signature: Uint8Array,
    algo: SignatureAlgorithm = "ed25519",
  ): Promise<boolean> {
    const entry = this.requireEntry(keyId);
    for (const sigVer of entry.sig.values()) {
      const pair = sigVer.pairs.get(algo);
      if (!pair) continue;
      const ok =
        algo === "ed25519"
          ? nodeVerify(
              null,
              Buffer.from(data),
              pair.publicKey,
              Buffer.from(signature),
            )
          : nodeVerify(
              "sha256",
              Buffer.from(data),
              { key: pair.publicKey, padding: 6, saltLength: 32 },
              Buffer.from(signature),
            );
      if (ok) return true;
    }
    return false;
  }

  async getPublicKey(keyId: KeyId): Promise<Uint8Array> {
    const entry = this.requireEntry(keyId);
    const sigVer = entry.sig.get(entry.currentVersion);
    if (!sigVer) throw new KeyNotFoundError(keyId, entry.currentVersion);
    // Default to ed25519 — callers needing the RSA key should sign first to materialize it.
    const pair =
      sigVer.pairs.get("ed25519") ??
      this.ensureSignPair(keyId, entry.currentVersion, "ed25519");
    if (!pair) throw new KmsError(`no public key for ${keyId}`);
    return pair.publicRaw;
  }
}
