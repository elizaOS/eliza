/**
 * SignerBackend — the honest threshold/MPC analog of {@link KeystoreBackend}.
 *
 * WHY THIS EXISTS (see D1-MPC-DECISION-2026-07-30.md §1, §7):
 * The existing `KeystoreBackend` contract is `encrypt(privateKey) -> EncryptedKey`
 * / `decrypt(EncryptedKey) -> privateKey`. That shape is *fundamentally
 * incompatible* with threshold signing: the whole point of FROST / MPC is that a
 * raw `privateKey` string NEVER exists in one place, so there is nothing to
 * `encrypt` and nothing for `decrypt` to hand back. Shoehorning threshold into
 * `KeystoreBackend` would force a backend to lie about being able to return a raw
 * key. Instead we introduce this sibling interface.
 *
 * The defining property is {@link SignerBackendCapabilities.canReturnRawKey}:
 * it is the literal type `false`. There is NO method on this interface that
 * exports private key material. `sign()` produces a signature via a threshold
 * ceremony; `generate()` runs a distributed-key-generation (DKG) or
 * trusted-dealer ceremony that yields only a public {@link ThresholdKeyRef}. A
 * backend that could return a raw key would use `KeystoreBackend`, not this.
 *
 * The classic AES/KMS/PKCS#11 path (KeystoreBackend) is untouched and remains
 * the default. Threshold signing is opt-in per wallet. See
 * `packages/vault/KEYSTORE-BACKENDS.md` for how the two relate.
 */

import type { KeystoreContext } from "./keystore-backend";

/** Threshold schemes a {@link SignerBackend} may implement. */
export type ThresholdScheme =
  | "frost-secp256k1"
  | "frost-ed25519"
  | "cggmp21-ecdsa";

/**
 * A reference to key MATERIAL THAT NEVER ASSEMBLES.
 *
 * For a threshold backend this holds a group id and the group public key, never
 * a private key. The address for a chain is derived from `publicKey`. The
 * individual signing shares live behind the backend (ideally each in its own
 * enclave — see THRESHOLD-SIGNING.md); this ref is the only thing the vault and
 * its call sites ever see.
 */
export interface ThresholdKeyRef {
  /** Backend id + parameters, e.g. "frost-secp256k1@2of3". */
  backend: string;
  /** Opaque handle to the DKG group / key-package set held by the backend. */
  groupId: string;
  /**
   * Group (verifying) public key, hex encoded. For frost-secp256k1 this is the
   * 33-byte compressed SEC1 point; an EVM/Safe address is derivable from it.
   */
  publicKey: string;
  scheme: ThresholdScheme;
  /** t — number of shares required to produce a signature. */
  threshold: number;
  /** n — total number of shares in the group. */
  participants: number;
}

/** Parameters for a key-generation ceremony. */
export interface ThresholdGenerateParams {
  scheme: ThresholdScheme;
  /** t — number of shares required to sign. */
  threshold: number;
  /** n — total number of shares to create. */
  participants: number;
}

/** Result of a threshold signing ceremony. */
export interface ThresholdSignature {
  /**
   * The aggregated group signature, raw bytes. For frost-secp256k1 this is a
   * 64-byte Schnorr signature (R‖z) that verifies against the group public key
   * — NOT a native EVM ECDSA signature. It authorizes EVM assets via a Safe /
   * EIP-1271 smart account (see THRESHOLD-SIGNING.md), not a plain EOA tx.
   */
  signature: Uint8Array;
  /** ECDSA-only recovery id, present only for cggmp21-ecdsa backends. */
  recid?: number;
}

/**
 * Compile-time honesty marker. The `canReturnRawKey: false` literal type is
 * load-bearing: it is impossible to construct a `SignerBackend` that advertises
 * a raw-key export path through this interface.
 */
export interface SignerBackendCapabilities {
  readonly canReturnRawKey: false;
  /** Whether the backend supports {@link SignerBackend.reshare}. */
  readonly supportsReshare: boolean;
}

/**
 * Produces signatures without ever returning a private key. The threshold analog
 * of {@link KeystoreBackend}.
 */
export interface SignerBackend {
  /** Human-readable id for logs/audit, e.g. "frost-secp256k1@2of3". */
  readonly id: string;

  /**
   * Run (or attach to) a key-generation ceremony — DKG or trusted-dealer — and
   * return a public key reference. No secret share ever leaves the backend /
   * enclaves. For the prototype, trusted-dealer keygen is acceptable when
   * labeled honestly (see the frost backend's docs).
   */
  generate(
    params: ThresholdGenerateParams,
    context?: KeystoreContext,
  ): Promise<ThresholdKeyRef>;

  /**
   * Produce a signature over a message via a threshold signing round. `message`
   * is the raw bytes to sign (for EVM this is the 32-byte digest the Safe /
   * EIP-1271 flow expects). Fewer than `ref.threshold` available shares MUST
   * cause this to reject — a threshold backend that can sign below threshold is
   * broken.
   */
  sign(
    ref: ThresholdKeyRef,
    message: Uint8Array,
    context?: KeystoreContext,
  ): Promise<ThresholdSignature>;

  /**
   * Verify a signature against a key ref's group public key. Provided so call
   * sites and tests can check a signature without importing scheme-specific
   * crypto. Implementations MUST NOT weaken this to always-true.
   */
  verify(
    ref: ThresholdKeyRef,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;

  /**
   * Optional resharing / proactive refresh: rotate the share set or change
   * t/n while preserving the group public key. Present only if
   * {@link SignerBackendCapabilities.supportsReshare} is true.
   */
  reshare?(
    ref: ThresholdKeyRef,
    next: { threshold: number; participants: number },
  ): Promise<ThresholdKeyRef>;

  readonly capabilities: SignerBackendCapabilities;
}

/**
 * Runtime + type guard that a value cannot export raw key material through the
 * SignerBackend contract. Useful in call sites that must fail closed if handed
 * something claiming to be a threshold backend but exposing a raw-key path.
 */
export function assertNoRawKeyExport(
  backend: SignerBackend,
): asserts backend is SignerBackend {
  // The type system already forbids canReturnRawKey !== false, but a backend
  // could be constructed via `any`/casts. Enforce it at runtime too.
  if (
    (backend.capabilities as { canReturnRawKey: unknown }).canReturnRawKey !==
    false
  ) {
    throw new Error(
      `SignerBackend '${backend.id}' claims canReturnRawKey !== false; ` +
        "threshold/MPC backends must never expose raw key export.",
    );
  }
}
