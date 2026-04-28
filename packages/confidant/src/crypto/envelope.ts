import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for a single secret value.
 *
 * Wire format: `v1:<nonce_b64>:<tag_b64>:<ct_b64>` where:
 *   - nonce: 12 bytes (96 bits, GCM standard).
 *   - tag: 16 bytes (128 bits, full GCM authentication tag).
 *   - ct: AES-256-GCM ciphertext of the UTF-8 plaintext.
 *
 * The secret id is bound as additional authenticated data (AAD) so that an
 * attacker who swaps two encrypted entries between slots in the store cannot
 * trick the reader into decrypting the wrong value. Decrypt fails fast.
 */

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export interface Envelope {
  /** ASCII-safe string suitable for storage in JSON. */
  readonly ciphertext: string;
}

export function encrypt(
  key: Buffer,
  plaintext: string,
  aad: string,
): Envelope {
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError(
      `master key must be ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [
      VERSION,
      nonce.toString("base64"),
      tag.toString("base64"),
      ct.toString("base64"),
    ].join(":"),
  };
}

export function decrypt(
  key: Buffer,
  envelope: Envelope | string,
  aad: string,
): string {
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError(
      `master key must be ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  const ciphertext =
    typeof envelope === "string" ? envelope : envelope.ciphertext;
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new EnvelopeError("malformed envelope or unsupported version");
  }
  const nonceB64 = parts[1];
  const tagB64 = parts[2];
  const ctB64 = parts[3];
  if (
    nonceB64 === undefined ||
    tagB64 === undefined ||
    ctB64 === undefined
  ) {
    throw new EnvelopeError("malformed envelope");
  }
  const nonce = Buffer.from(nonceB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (nonce.length !== NONCE_BYTES) {
    throw new EnvelopeError(
      `nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`,
    );
  }
  if (tag.length !== TAG_BYTES) {
    throw new EnvelopeError(
      `tag must be ${TAG_BYTES} bytes, got ${tag.length}`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  } catch (err) {
    throw new EnvelopeError(
      err instanceof Error
        ? `decryption failed: ${err.message}`
        : "decryption failed",
    );
  }
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}
