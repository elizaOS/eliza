/**
 * Cross-platform OS secret store — **contract only** (no native bindings here).
 *
 * **Spec:** [Platform secure store (design)](../../../../docs/guides/platform-secure-store.md)
 *
 * Implementations live per runtime (e.g. Electrobun main process, Node CLI with
 * native addons). Wallet and other callers depend on this interface + shared
 * `vaultId` / `secretKind` conventions.
 */

/** Logical secret slot within a vault (one state profile). */
export type SecureStoreSecretKind =
  | "wallet.evm_private_key"
  | "wallet.solana_private_key"
  | "steward.api_url"
  | "steward.tenant_id"
  | "steward.agent_id"
  | "steward.api_key"
  | "steward.agent_token"
  /** Device-bound P-256 controller signing private key (PKCS#8/JWK wrapper). */
  | "remote.controller_signing_key"
  /** Device-bound P-256 controller key-agreement private key. */
  | "remote.controller_encryption_key"
  /** Public controller identity paired with the device-bound private keys. */
  | "remote.controller_identity"
  /** Bearer credential for one saved remote runtime. */
  | "remote.runtime_access_token"
  /** SSH private key or opaque native key reference for one server. */
  | "remote.ssh_private_key";

export type SecureStoreUnavailableReason =
  | "not_found"
  | "denied"
  | "unavailable"
  | "error";

export type SecureStoreGetResult =
  | { ok: true; value: string }
  | {
      ok: false;
      reason: SecureStoreUnavailableReason;
      message?: string;
    };

export type SecureStoreSetResult =
  | { ok: true }
  | { ok: false; reason: SecureStoreUnavailableReason; message?: string };

/**
 * Which native API backs this implementation (for diagnostics and support).
 */
export type PlatformSecureStoreBackend =
  | "macos_keychain"
  | "windows_credential_manager"
  | "linux_secret_service"
  /** Encrypted file or DPAPI-like blob under state dir — only after explicit consent. */
  | "file_encrypted_fallback"
  /** Legacy / tests: no OS integration. */
  | "none";

/**
 * Platform-provided secret storage scoped by `vaultId` (see design doc for derivation).
 */
export interface PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend;

  get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult>;

  set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult>;

  delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void>;

  /** True if the backend can run on this host right now (e.g. Secret Service up). */
  isAvailable(): Promise<boolean>;
}
