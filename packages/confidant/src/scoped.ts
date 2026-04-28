import type { SecretId } from "./types.js";

/**
 * The only Confidant a skill ever sees. Every call goes through policy
 * enforcement and the audit log.
 *
 * Skill code cannot reach the unscoped Confidant. There is no
 * `getConfidant()` global — the runtime's plugin loader hands a
 * `ScopedConfidant` to each plugin at registration and that instance is the
 * skill's only seam.
 */
export interface ScopedConfidant {
  /** Resolve a secret to its plaintext value. */
  resolve(id: SecretId): Promise<string>;
  /** Lazy resolver — pass to HTTP clients so the secret is fetched per call. */
  lazyResolve(id: SecretId): () => Promise<string>;
  /** Existence check. Does NOT reveal the value. */
  has(id: SecretId): Promise<boolean>;
}
