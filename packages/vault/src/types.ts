/**
 * Public types for @elizaos/vault.
 *
 * The vault holds two kinds of things keyed by a string:
 *   - sensitive values (API keys, tokens, private keys) — encrypted at rest
 *   - non-sensitive values (config: theme, model preferences, flags) — plaintext
 *
 * The same `set/get/has/describe/list/remove` API serves both; the caller
 * declares sensitivity at write time. Reads don't need to know.
 */

/** Reference to a value held in an external password manager. */
export interface PasswordManagerReference {
  readonly source: "1password" | "protonpass";
  /** Vendor-specific path. e.g., "Personal/OpenRouter/api-key" for op://. */
  readonly path: string;
}

/** Internal storage shape. Consumers use `describe()` to inspect, never see this directly. */
export type StoredEntry =
  | {
      readonly kind: "value";
      readonly value: string;
      readonly lastModified: number;
    }
  | {
      readonly kind: "secret";
      /** AES-256-GCM ciphertext: `v1:nonce:tag:ct` (all base64). */
      readonly ciphertext: string;
      readonly lastModified: number;
    }
  | {
      readonly kind: "reference";
      readonly source: PasswordManagerReference["source"];
      readonly path: string;
      readonly lastModified: number;
    };

export interface VaultDescriptor {
  readonly key: string;
  readonly source: "file" | "keychain-encrypted" | "1password" | "protonpass";
  readonly sensitive: boolean;
  readonly lastModified: number;
}

export interface VaultStats {
  readonly total: number;
  readonly sensitive: number;
  readonly nonSensitive: number;
  readonly references: number;
}

export interface AuditRecord {
  readonly ts: number;
  readonly action: "set" | "setReference" | "get" | "reveal" | "remove";
  readonly key: string;
  /** Caller-supplied identifier for who's asking. Optional. */
  readonly caller?: string;
}

export interface VaultLogger {
  readonly warn: (msg: string, ctx?: unknown) => void;
  readonly error: (msg: string, ctx?: unknown) => void;
}
