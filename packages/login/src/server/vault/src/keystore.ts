// node:crypto under Cloudflare nodejs_compat:
//   - createCipheriv / createDecipheriv (AES-256-GCM) - supported.
//   - randomBytes                                      - supported.
//   - scryptSync                                       - supported. Sync work
//     runs on the request CPU budget (~10ms by default, configurable). Default
//     N=16384 derivation is well under budget. If a future caller raises N,
//     consider crypto.subtle.deriveBits with PBKDF2-SHA256 as an async
//     alternative - note that switching KDFs invalidates existing encrypted
//     records (operator decision, not a transparent migration).
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { decodeKdfSalt } from "./kdf-salt";
import type { KeystoreContext } from "./keystore-backend";

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
  salt: string; // hex for AES default, envelope metadata for KMS backends
  backend?: string;
  wrappedDataKey?: string; // hex
  provider?: string;
  keyId?: string;
}

/**
 * KDF domain labels for cryptographic separation between vault roots derived
 * from the SAME master password. Without this, the secret-vault and the wallet
 * signing-vault share an identical root key — compromising one path compromises
 * both. Each domain mixes a distinct label into the scrypt master-key salt so
 * the two roots are cryptographically independent.
 *
 * - undefined  → legacy derivation (no label). Preserves decryptability of all
 *                data encrypted before domain separation existed.
 * - "signing-vault" / "secret-vault" → independent roots.
 */
export type KeyStoreDomain =
  | "signing-vault"
  | "secret-vault"
  | "credential-lease";

export class KeyStore {
  private masterKey: Buffer;

  /**
   * @param masterPassword  The master password to derive the root encryption key from.
   * @param masterSalt      Optional salt for master key derivation. In production, set
   *                        STEWARD_KDF_SALT env var to a unique per-deployment random hex
   *                        string (at least 32 hex chars). Falls back to a built-in
   *                        default for backward compatibility, but this weakens KDF
   *                        resistance to precomputed attacks.
   * @param domain          Optional KDF domain label for cryptographic separation between
   *                        roots derived from the same master password. Omit for the legacy
   *                        (undifferentiated) root used before domain separation.
   */
  constructor(
    masterPassword: string,
    masterSalt?: string,
    domain?: KeyStoreDomain,
  ) {
    // Derive a 256-bit root key from master password via scrypt.
    // Each encrypt() call further derives a unique key with a random per-record salt,
    // so the master key salt does not need to be per-record, but SHOULD be unique
    // per deployment to resist precomputed/rainbow-table attacks on the password.
    const envSalt = masterSalt ?? process.env.STEWARD_KDF_SALT;
    let salt: Buffer;
    if (envSalt) {
      salt = decodeKdfSalt(envSalt);
    } else {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "STEWARD_KDF_SALT is required in production. Generate with: openssl rand -hex 32",
        );
      }
      salt = Buffer.from("steward-vault-v1");
    }
    // Domain separation: namespace the master-key salt with a domain label so two
    // roots from the same password are cryptographically independent. Legacy callers
    // (domain undefined) keep the exact pre-separation derivation for backward compat.
    const domainSalt = domain
      ? Buffer.from(`steward-kdf:${domain}:${salt.toString("hex")}`)
      : salt;
    this.masterKey = scryptSync(masterPassword, domainSalt, 32) as Buffer;
  }

  /**
   * Encrypt a private key for storage
   */
  encrypt(privateKey: string, context?: KeystoreContext): EncryptedKey {
    const iv = randomBytes(16);
    const salt = randomBytes(16);

    // Derive a unique key for this encryption using the salt
    const derivedKey = scryptSync(this.masterKey, salt, 32) as Buffer;
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    const aad = aadForContext(context);
    if (aad) cipher.setAAD(aad);

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
   * Decrypt a private key for signing (ephemeral - caller should zero after use)
   */
  decrypt(encrypted: EncryptedKey, context?: KeystoreContext): string {
    if (context) {
      try {
        return this.decryptWithContext(encrypted, context);
      } catch (error) {
        // Legacy ciphertexts were written before context binding existed.
        // Keep them readable outside production so operators can migrate by
        // re-encrypting rows. Production fallback must be an explicit break-glass
        // setting; otherwise copied legacy ciphertext can defeat tenant/agent AAD.
        if (!allowLegacyDecryptFallback()) throw error;
      }
    }
    return this.decryptWithContext(encrypted);
  }

  private decryptWithContext(
    encrypted: EncryptedKey,
    context?: KeystoreContext,
  ): string {
    const iv = Buffer.from(encrypted.iv, "hex");
    const salt = Buffer.from(encrypted.salt, "hex");
    const tag = Buffer.from(encrypted.tag, "hex");

    const derivedKey = scryptSync(this.masterKey, salt, 32) as Buffer;
    const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
    const aad = aadForContext(context);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    let plaintext = decipher.update(encrypted.ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");

    return plaintext;
  }
}

function aadForContext(context?: KeystoreContext): Buffer | null {
  if (!context) return null;
  const normalized = {
    agentId: context.agentId ?? "",
    chainFamily: context.chainFamily ?? "",
    name: context.name ?? "",
    tenantId: context.tenantId ?? "",
    venue: context.venue ?? "",
    version: context.version ?? "",
  };
  return Buffer.from(
    `steward-keystore-v2:${JSON.stringify(normalized)}`,
    "utf8",
  );
}

function allowLegacyDecryptFallback(): boolean {
  // The no-AAD fallback defeats tenant/agent/venue context binding (a copied
  // ciphertext row would decrypt across contexts). It is ONLY for migrating
  // pre-context-binding ciphertext outside production. Production NEVER takes
  // this path, regardless of the env flag — the flag cannot enable it in prod.
  if (process.env.NODE_ENV === "production") return false;
  return process.env.STEWARD_ALLOW_LEGACY_KEYSTORE_DECRYPT_FALLBACK === "true";
}
