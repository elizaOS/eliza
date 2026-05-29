import { type EncryptResult, type GetOrCreateKeyOptions, type KeyHandle, type KeyId, type KeyVersion, type KmsClient, type SignResult, type SignatureAlgorithm } from "./types.js";
export interface MemoryKmsOptions {
    /** Deterministic key material (test-fixtures only). */
    seed?: () => Uint8Array;
}
export declare class MemoryKmsAdapter implements KmsClient {
    private readonly keys;
    private readonly seed;
    constructor(opts?: MemoryKmsOptions);
    private materialize;
    private ensureEntry;
    private requireEntry;
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
    private ensureSignPair;
    sign(keyId: KeyId, data: Uint8Array, algo?: SignatureAlgorithm): Promise<SignResult>;
    verify(keyId: KeyId, data: Uint8Array, signature: Uint8Array, algo?: SignatureAlgorithm): Promise<boolean>;
    getPublicKey(keyId: KeyId): Promise<Uint8Array>;
}
//# sourceMappingURL=memory-adapter.d.ts.map