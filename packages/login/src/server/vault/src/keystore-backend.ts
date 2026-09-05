/**
 * KeystoreBackend — pluggable persistence interface for private-key material.
 *
 * The default `KeyStore` from `./keystore` is a single-process AES-256-GCM
 * backend: keys live in the application DB, encrypted at rest with a master
 * password derived via scrypt. That model is the right answer for most
 * deployments — simple, auditable, no external dependencies.
 *
 * Operators with different trust requirements (threshold/MPC signing, TEE-
 * attested execution, cloud HSM custody) can ship their own backend by
 * implementing this interface and wiring it in via VaultConfig. The vault
 * does not assume anything about how `encrypt`/`decrypt` are implemented;
 * it only requires that the returned `EncryptedKey` round-trips through
 * `decrypt`.
 *
 * This file defines the contract, not an MPC implementation. Shipping a
 * full threshold-signing protocol from inside this monorepo would be
 * theater — the security comes from running multiple independent operators,
 * which is an operational concern outside the codebase. The interface here
 * is the plug, not the network.
 */

import type { EncryptedKey } from "./keystore";

export interface KeystoreBackend {
  /**
   * Encrypt a private key for storage. The opaque `EncryptedKey` produced
   * must round-trip through `decrypt` to yield the same plaintext.
   */
  encrypt(
    privateKey: string,
    context?: KeystoreContext,
  ): EncryptedKey | Promise<EncryptedKey>;

  /**
   * Decrypt a private key for an ephemeral signing operation. Backends
   * should treat the returned plaintext as short-lived material and the
   * caller is expected to use it immediately and drop the reference.
   */
  decrypt(
    encrypted: EncryptedKey,
    context?: KeystoreContext,
  ): string | Promise<string>;

  /**
   * Human-readable identifier for this backend, e.g. "aes-256-gcm@scrypt"
   * or "mpc:lit-v1". Used in logs/audit, not in security decisions.
   */
  readonly id: string;
}

/**
 * Per-call context. Backends that bind ciphertext to (tenant, agent) or to
 * a specific signing session can use these fields; the default in-process
 * backend ignores them. Optional so the existing call sites don't change.
 */
export interface KeystoreContext {
  tenantId?: string;
  agentId?: string;
  chainFamily?: string;
  name?: string;
  /** Trading venue or other scope label, see VenueId in @stwd/shared. */
  venue?: string | null;
  version?: number | string;
}

/**
 * Wrap an existing `KeyStore` instance as a `KeystoreBackend`. Lets the
 * vault take a uniform `KeystoreBackend` everywhere while continuing to use
 * the AES-256-GCM default unless an operator swaps it.
 */
export function backendFromKeyStore(ks: {
  encrypt(pk: string, context?: KeystoreContext): EncryptedKey;
  decrypt(e: EncryptedKey, context?: KeystoreContext): string;
}): KeystoreBackend {
  return {
    id: "aes-256-gcm@scrypt",
    encrypt(privateKey: string, context?: KeystoreContext) {
      return ks.encrypt(privateKey, context);
    },
    decrypt(encrypted: EncryptedKey, context?: KeystoreContext) {
      return ks.decrypt(encrypted, context);
    },
  };
}
