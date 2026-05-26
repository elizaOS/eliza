import { type EncryptResult, type GetOrCreateKeyOptions, type KeyHandle, type KeyId, type KeyVersion, type KmsClient, type SignResult, type SignatureAlgorithm } from "./types.js";
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
export declare class LocalKmsAdapter implements KmsClient {
    private readonly rootKey;
    private readonly state;
    private readonly inner;
    constructor(opts: LocalKmsOptions);
    static fromPassphrase(passphrase: string, salt: string): LocalKmsAdapter;
    private deriveSym;
    private ensureState;
    getOrCreateKey(keyId: KeyId, _opts?: GetOrCreateKeyOptions): Promise<KeyHandle>;
    rotateKey(keyId: KeyId): Promise<{
        keyId: KeyId;
        newVersion: KeyVersion;
    }>;
    listKeyVersions(keyId: KeyId): Promise<KeyVersion[]>;
    encrypt(keyId: KeyId, plaintext: Uint8Array, aad?: Uint8Array): Promise<EncryptResult>;
    decrypt(keyId: KeyId, ciphertext: Uint8Array, nonce: Uint8Array, authTag: Uint8Array, aad?: Uint8Array, keyVersion?: KeyVersion): Promise<Uint8Array>;
    hmac(keyId: KeyId, data: Uint8Array): Promise<Uint8Array>;
    hmacVerify(keyId: KeyId, data: Uint8Array, tag: Uint8Array): Promise<boolean>;
    sign(keyId: KeyId, data: Uint8Array, algo?: SignatureAlgorithm): Promise<SignResult>;
    verify(keyId: KeyId, data: Uint8Array, signature: Uint8Array, algo?: SignatureAlgorithm): Promise<boolean>;
    getPublicKey(keyId: KeyId): Promise<Uint8Array>;
}
export declare function randomRootKey(): Uint8Array;
//# sourceMappingURL=local-adapter.d.ts.map