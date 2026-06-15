export type KeyId = string;
export type KeyVersion = number;
export type SignatureAlgorithm = "ed25519" | "rsa-pss-sha256";

export interface EncryptResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyId: KeyId;
  keyVersion: KeyVersion;
}

export interface SignResult {
  signature: Uint8Array;
  algorithm: SignatureAlgorithm;
  keyId: KeyId;
  keyVersion: KeyVersion;
}

export interface KeyHandle {
  keyId: KeyId;
  version: KeyVersion;
}

export interface GetOrCreateKeyOptions {
  rotationDays?: number;
}

export interface KmsClient {
  encrypt(
    keyId: KeyId,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<EncryptResult>;
  decrypt(
    keyId: KeyId,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    authTag: Uint8Array,
    aad?: Uint8Array,
    keyVersion?: KeyVersion,
  ): Promise<Uint8Array>;

  getOrCreateKey(
    keyId: KeyId,
    opts?: GetOrCreateKeyOptions,
  ): Promise<KeyHandle>;
  rotateKey(keyId: KeyId): Promise<{ keyId: KeyId; newVersion: KeyVersion }>;
  listKeyVersions(keyId: KeyId): Promise<KeyVersion[]>;

  hmac(keyId: KeyId, data: Uint8Array): Promise<Uint8Array>;
  hmacVerify(keyId: KeyId, data: Uint8Array, tag: Uint8Array): Promise<boolean>;

  sign(
    keyId: KeyId,
    data: Uint8Array,
    algo?: SignatureAlgorithm,
  ): Promise<SignResult>;
  verify(
    keyId: KeyId,
    data: Uint8Array,
    signature: Uint8Array,
    algo?: SignatureAlgorithm,
  ): Promise<boolean>;
  getPublicKey(keyId: KeyId): Promise<Uint8Array>;
}

export class KmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsError";
  }
}

export class KeyNotFoundError extends KmsError {
  constructor(keyId: KeyId, version?: KeyVersion) {
    super(
      version !== undefined
        ? `key not found: ${keyId} v${version}`
        : `key not found: ${keyId}`,
    );
    this.name = "KeyNotFoundError";
  }
}

export class NotImplementedError extends KmsError {
  constructor(what: string) {
    super(`unsupported KMS operation: ${what}`);
    this.name = "NotImplementedError";
  }
}
