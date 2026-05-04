import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for a single value.
 *
 * Wire format: `v1:<nonce_b64>:<tag_b64>:<ct_b64>` (all base64).
 *   - nonce: 12 bytes (96-bit GCM standard)
 *   - tag:   16 bytes (128-bit auth tag)
 *
 * The vault key is bound as additional authenticated data (AAD) so a
 * swapped ciphertext between slots fails decryption.
 */

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encrypt(
  masterKey: Buffer,
  plaintext: string,
  aad: string,
): string {
  if (masterKey.length !== KEY_BYTES) {
    throw new CryptoError(`master key must be ${KEY_BYTES} bytes`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(
  masterKey: Buffer,
  ciphertext: string,
  aad: string,
): string {
  if (masterKey.length !== KEY_BYTES) {
    throw new CryptoError(`master key must be ${KEY_BYTES} bytes`);
  }
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new CryptoError("malformed ciphertext or unsupported version");
  }
  const nonceB64 = parts[1];
  const tagB64 = parts[2];
  const ctB64 = parts[3];
  if (nonceB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new CryptoError("malformed ciphertext");
  }
  const nonce = Buffer.from(nonceB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError("malformed ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  } catch (err) {
    throw new CryptoError(
      err instanceof Error
        ? `decryption failed: ${err.message}`
        : "decryption failed",
    );
  }
}
