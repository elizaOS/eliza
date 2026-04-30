import type { VaultReference, VaultSource } from "../types.js";

/**
 * VaultBackend is the seam at which a stored reference becomes a plaintext
 * value. The Confidant orchestrates registration of multiple backends and
 * routes references by scheme.
 *
 * Backends with no `store` cannot be the target of a literal write — values
 * are entered through the backend's own UI (e.g., 1Password's app).
 */
export interface VaultBackend {
  readonly source: VaultSource;
  /** Returns the plaintext for a reference. */
  resolve(ref: VaultReference): Promise<string>;
  /** Optional: persist a literal value, returning the reference to it. */
  store?(id: string, value: string): Promise<VaultReference>;
  /** Optional: remove a previously-stored value. */
  remove?(ref: VaultReference): Promise<void>;
}

export class BackendError extends Error {
  constructor(
    readonly source: VaultSource,
    message: string,
  ) {
    super(`[${source}] ${message}`);
    this.name = "BackendError";
  }
}

export class BackendNotConfiguredError extends BackendError {
  constructor(source: VaultSource, message: string) {
    super(source, message);
    this.name = "BackendNotConfiguredError";
  }
}
