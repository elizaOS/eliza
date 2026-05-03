// node:crypto under Cloudflare nodejs_compat:
//   - createCipheriv / createDecipheriv (AES-256-GCM) — supported.
//   - randomBytes                                      — supported.
//   - scryptSync                                       — supported. Sync work
//     runs on the request CPU budget (~10ms by default, configurable). Default
//     N=16384 derivation is well under budget. If a future caller raises N,
//     consider crypto.subtle.deriveBits with PBKDF2-SHA256 as an async
//     alternative — note that switching KDFs invalidates existing encrypted
//     records (operator decision, not a transparent migration).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encrypted keystore. Private keys are encrypted at rest using AES-256-GCM.
 * The encryption key is derived from a master password via scrypt.
 *
 * In production, the master key should come from an env var or secret manager.
 * Keys are never held in memory longer than needed for signing.
 */

export interface EncryptedKey {
  ciphertext: string; // hex
  iv: string; // hex
  tag: string; // hex
  salt: string; // hex
}

export class KeyStore {
  private masterKey: Buffer;

  /**
   * @param masterPassword  The master password to derive the root encryption key from.
   * @param masterSalt      Optional salt for master key derivation. In production, set
   *                        STEWARD_KDF_SALT env var to a unique per-deployment random hex
   *                        string (at least 32 hex chars). Falls back to a built-in
   *                        default for backward compatibility, but this weakens KDF
   *                        resistance to precomputed attacks.
   */
  constructor(masterPassword: string, masterSalt?: string) {
    // Derive a 256-bit root key from master password via scrypt.
    // Each encrypt() call further derives a unique key with a random per-record salt,
    // so the master key salt does not need to be per-record, but SHOULD be unique
    // per deployment to resist precomputed/rainbow-table attacks on the password.
    const envSalt = masterSalt ?? process.env.STEWARD_KDF_SALT;
    let salt: Buffer;
    if (envSalt) {
      salt = Buffer.from(envSalt, "hex");
    } else {
      // Legacy default: deterministic but known. Acceptable because encrypt() adds
      // per-record randomness, but a per-deployment salt is strongly recommended.
      salt = Buffer.from("steward-vault-v1");
      if (process.env.NODE_ENV === "production") {
        console.warn(
          "\u26a0\ufe0f [KeyStore] Using default KDF salt. Set STEWARD_KDF_SALT to a random hex string for production.",
        );
      }
    }
    this.masterKey = scryptSync(masterPassword, salt, 32) as Buffer;
  }

  /**
   * Encrypt a private key for storage
   */
  encrypt(privateKey: string): EncryptedKey {
    const iv = randomBytes(16);
    const salt = randomBytes(16);

    // Derive a unique key for this encryption using the salt
    const derivedKey = scryptSync(this.masterKey, salt, 32) as Buffer;
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);

    let ciphertext = cipher.update(privateKey, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag();

    return {
      ciphertext,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      salt: salt.toString("hex"),
    };
  }

  /**
   * Decrypt a private key for signing (ephemeral — caller should zero after use)
   */
  decrypt(encrypted: EncryptedKey): string {
    const iv = Buffer.from(encrypted.iv, "hex");
    const salt = Buffer.from(encrypted.salt, "hex");
    const tag = Buffer.from(encrypted.tag, "hex");

    const derivedKey = scryptSync(this.masterKey, salt, 32) as Buffer;
    const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAuthTag(tag);

    let plaintext = decipher.update(encrypted.ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");

    return plaintext;
  }
}
