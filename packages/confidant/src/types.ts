/**
 * Public types for @elizaos/confidant.
 *
 * Identifier convention: `domain.subject.field`
 * Example: `llm.openrouter.apiKey`, `subscription.openai.accessToken`.
 */

export type SecretId = string;

export type VaultSource =
  | "file"
  | "keyring"
  | "1password"
  | "protonpass"
  | "cloud"
  | "env-legacy";

export type VaultReference = string;

export interface SecretSchemaEntry {
  readonly id: SecretId;
  readonly label: string;
  readonly description?: string;
  readonly formatHint?: string;
  readonly sensitive: boolean;
  readonly pluginId: string;
}

export interface SecretDescriptor {
  readonly id: SecretId;
  readonly source: VaultSource;
  readonly isReference: boolean;
  readonly lastModified: number;
  readonly schema?: SecretSchemaEntry;
}

export interface ResolveDetail {
  readonly value: string;
  readonly source: VaultSource;
  readonly cached: boolean;
  readonly promptedUser: boolean;
}

export type GrantMode = "always" | "prompt" | "audit" | "deny";

export interface Grant {
  readonly pattern: string;
  readonly mode: GrantMode;
  readonly grantedAt: number;
  readonly reason?: string;
}

export interface AuditRecord {
  readonly ts: number;
  readonly skill: string;
  readonly secret: SecretId;
  readonly granted: boolean;
  readonly source?: VaultSource;
  readonly cached?: boolean;
  readonly reason?: string;
}

export interface PromptHandler {
  /**
   * Asked when a skill triggers a `prompt`-mode grant for the first time
   * in a session. Resolves to true if the user approved the access.
   *
   * Phase 0 default: always-deny (no UI to render the prompt). The runtime
   * must pass a real handler to enable cross-plugin access.
   */
  promptForGrant(input: {
    readonly skillId: string;
    readonly secretId: SecretId;
    readonly reason?: string;
  }): Promise<boolean>;
}

export interface ConfidantLogger {
  readonly debug?: (msg: string, ctx?: unknown) => void;
  readonly info?: (msg: string, ctx?: unknown) => void;
  readonly warn: (msg: string, ctx?: unknown) => void;
  readonly error: (msg: string, ctx?: unknown) => void;
}
