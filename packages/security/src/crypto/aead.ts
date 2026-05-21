import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AEAD_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;

export interface AeadOutput {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
}

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AeadError";
  }
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function aeadEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): AeadOutput {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new AeadError(`AEAD key must be ${AEAD_KEY_BYTES} bytes`);
  }
  const nonce = randomBytes(AEAD_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", asBuffer(key), nonce);
  if (aad && aad.length > 0) cipher.setAAD(asBuffer(aad));
  const ct = Buffer.concat([cipher.update(asBuffer(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: new Uint8Array(ct),
    nonce: new Uint8Array(nonce),
    authTag: new Uint8Array(authTag),
  };
}

export function aeadDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  authTag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new AeadError(`AEAD key must be ${AEAD_KEY_BYTES} bytes`);
  }
  if (nonce.length !== AEAD_NONCE_BYTES) {
    throw new AeadError(`AEAD nonce must be ${AEAD_NONCE_BYTES} bytes`);
  }
  if (authTag.length !== AEAD_TAG_BYTES) {
    throw new AeadError(`AEAD tag must be ${AEAD_TAG_BYTES} bytes`);
  }
  const decipher = createDecipheriv("aes-256-gcm", asBuffer(key), asBuffer(nonce));
  if (aad && aad.length > 0) decipher.setAAD(asBuffer(aad));
  decipher.setAuthTag(asBuffer(authTag));
  try {
    const pt = Buffer.concat([
      decipher.update(asBuffer(ciphertext)),
      decipher.final(),
    ]);
    return new Uint8Array(pt);
  } catch (err) {
    throw new AeadError(
      err instanceof Error ? `AEAD decrypt failed: ${err.message}` : "AEAD decrypt failed",
    );
  }
}
