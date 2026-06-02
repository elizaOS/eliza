import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { aeadDecrypt, aeadEncrypt } from "../crypto/aead.js";
import { hkdfSha256 } from "../crypto/hkdf.js";
import { parseKeyId } from "./key-namespace.js";
import { MemoryKmsAdapter } from "./memory-adapter.js";
import {
  type EncryptResult,
  type GetOrCreateKeyOptions,
  type KeyHandle,
  type KeyId,
  type KeyVersion,
  type KmsClient,
  KmsError,
  type SignatureAlgorithm,
  type SignResult,
} from "./types.js";

/**
 * Single-user desktop adapter.
 *
 * Wraps `@elizaos/vault`'s master-key resolution (OS keychain → scrypt passphrase)
 * to obtain a 32-byte root key, then derives per-`keyId` / per-version subkeys
 * via HKDF-SHA256. Signing keys are held in-process (regenerated on boot from
 * the same root via deterministic HKDF + ed25519 seed expansion).
 *
 * For the desktop case we don't persist arbitrary key versions across restarts
 * beyond what HKDF gives us deterministically; the key registry (which versions
 * exist for which `keyId`) is held in-process and reseeded by the caller.
 *
 * This adapter is intentionally a thin shim over `MemoryKmsAdapter` for
 * sign/verify/HMAC behavior, with the symmetric AEAD path overridden to use
 * the HKDF-derived deterministic subkey instead of random key material — so
 * the same desktop install can decrypt its own at-rest data after restart
 * (assuming the vault master key resolves to the same bytes).
 */
export interface LocalKmsOptions {
  /** 32-byte root key. Caller resolves via `@elizaos/vault` master-key API. */
  rootKey: Uint8Array;
}

interface VersionState {
  current: KeyVersion;
  versions: Set<KeyVersion>;
}

const HKDF_DOMAIN = "elizaos.security.local-kms.v1";

export class LocalKmsAdapter implements KmsClient {
  private readonly rootKey: Uint8Array;
  private readonly state = new Map<KeyId, VersionState>();
  private readonly inner: MemoryKmsAdapter;

  constructor(opts: LocalKmsOptions) {
    if (opts.rootKey.length !== 32) {
      throw new KmsError("LocalKmsAdapter rootKey must be 32 bytes");
    }
    this.rootKey = opts.rootKey;
    this.inner = new MemoryKmsAdapter();
  }

  static fromPassphrase(passphrase: string, salt: string): LocalKmsAdapter {
    const rootKey = new Uint8Array(scryptSync(passphrase, salt, 32));
    return new LocalKmsAdapter({ rootKey });
  }

  private deriveSym(keyId: KeyId, version: KeyVersion): Uint8Array {
    const info = Buffer.from(`${HKDF_DOMAIN}|sym|${keyId}|v${version}`, "utf8");
    return hkdfSha256(this.rootKey, 32, info);
  }

  private deriveEd25519PrivateKey(keyId: KeyId, version: KeyVersion) {
    const info = Buffer.from(
      `${HKDF_DOMAIN}|sign|ed25519|${keyId}|v${version}`,
      "utf8",
    );
    const seed = Buffer.from(hkdfSha256(this.rootKey, 32, info));
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  }

  private ensureState(keyId: KeyId): VersionState {
    parseKeyId(keyId);
    let s = this.state.get(keyId);
    if (!s) {
      s = { current: 1, versions: new Set([1]) };
      this.state.set(keyId, s);
    }
    return s;
  }

  async getOrCreateKey(
    keyId: KeyId,
    _opts: GetOrCreateKeyOptions = {},
  ): Promise<KeyHandle> {
    const s = this.ensureState(keyId);
    return { keyId, version: s.current };
  }

  async rotateKey(
    keyId: KeyId,
  ): Promise<{ keyId: KeyId; newVersion: KeyVersion }> {
    const s = this.ensureState(keyId);
    const newVersion = s.current + 1;
    s.versions.add(newVersion);
    s.current = newVersion;
    return { keyId, newVersion };
  }

  async listKeyVersions(keyId: KeyId): Promise<KeyVersion[]> {
    const s = this.ensureState(keyId);
    return [...s.versions].sort((a, b) => a - b);
  }

  async encrypt(
    keyId: KeyId,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<EncryptResult> {
    const s = this.ensureState(keyId);
    const k = this.deriveSym(keyId, s.current);
    const out = aeadEncrypt(k, plaintext, aad);
    return { ...out, keyId, keyVersion: s.current };
  }

  async decrypt(
    keyId: KeyId,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    authTag: Uint8Array,
    aad?: Uint8Array,
    keyVersion?: KeyVersion,
  ): Promise<Uint8Array> {
    const s = this.ensureState(keyId);
    const version = keyVersion ?? s.current;
    const k = this.deriveSym(keyId, version);
    const plaintext = aeadDecrypt(k, ciphertext, nonce, authTag, aad);
    s.versions.add(version);
    return plaintext;
  }

  async hmac(keyId: KeyId, data: Uint8Array): Promise<Uint8Array> {
    const s = this.ensureState(keyId);
    const info = Buffer.from(
      `${HKDF_DOMAIN}|hmac|${keyId}|v${s.current}`,
      "utf8",
    );
    const macKey = hkdfSha256(this.rootKey, 32, info);
    const mac = createHmac("sha256", Buffer.from(macKey))
      .update(Buffer.from(data))
      .digest();
    return new Uint8Array(mac);
  }

  async hmacVerify(
    keyId: KeyId,
    data: Uint8Array,
    tag: Uint8Array,
  ): Promise<boolean> {
    const s = this.ensureState(keyId);
    for (const v of s.versions) {
      const info = Buffer.from(`${HKDF_DOMAIN}|hmac|${keyId}|v${v}`, "utf8");
      const macKey = hkdfSha256(this.rootKey, 32, info);
      const expected = createHmac("sha256", Buffer.from(macKey))
        .update(Buffer.from(data))
        .digest();
      if (expected.length !== tag.length) continue;
      if (timingSafeEqual(expected, Buffer.from(tag))) return true;
    }
    return false;
  }

  async sign(
    keyId: KeyId,
    data: Uint8Array,
    algo: SignatureAlgorithm = "ed25519",
  ): Promise<SignResult> {
    if (algo === "ed25519") {
      const s = this.ensureState(keyId);
      const privateKey = this.deriveEd25519PrivateKey(keyId, s.current);
      const signature = nodeSign(null, Buffer.from(data), privateKey);
      return {
        signature: new Uint8Array(signature),
        algorithm: algo,
        keyId,
        keyVersion: s.current,
      };
    }
    return this.inner.sign(keyId, data, algo);
  }
  async verify(
    keyId: KeyId,
    data: Uint8Array,
    signature: Uint8Array,
    algo: SignatureAlgorithm = "ed25519",
  ): Promise<boolean> {
    if (algo === "ed25519") {
      const s = this.ensureState(keyId);
      for (const version of s.versions) {
        const privateKey = this.deriveEd25519PrivateKey(keyId, version);
        const publicKey = createPublicKey(privateKey);
        if (
          nodeVerify(null, Buffer.from(data), publicKey, Buffer.from(signature))
        ) {
          return true;
        }
      }
      return false;
    }
    return this.inner.verify(keyId, data, signature, algo);
  }
  async getPublicKey(keyId: KeyId): Promise<Uint8Array> {
    const s = this.ensureState(keyId);
    const privateKey = this.deriveEd25519PrivateKey(keyId, s.current);
    const publicKey = createPublicKey(privateKey);
    return new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
  }
}

export function randomRootKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
