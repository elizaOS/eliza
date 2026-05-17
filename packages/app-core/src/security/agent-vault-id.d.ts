import type { SecureStoreSecretKind } from "./platform-secure-store";
/** Fixed Keychain / Secret Service “service” identifier (see docs/guides/platform-secure-store.md). */
export declare const ELIZA_AGENT_VAULT_SERVICE = "ai.elizaos.agent.vault";
/**
 * Canonical state directory for this process. Mirrors the canonical
 * `ELIZA_STATE_DIR` > `~/.${namespace}` precedence
 * and uses `realpathSync` when the path exists so symlinks normalize
 * consistently.
 */
export declare function resolveCanonicalStateDir(): string;
/**
 * Opaque vault id for OS secret stores: `mldy1-` + first 16 chars of base64url(sha256(canonicalStateDir)).
 */
export declare function deriveAgentVaultId(canonicalStateDir?: string): string;
export declare function keychainAccountForSecretKind(vaultId: string, kind: SecureStoreSecretKind): string;
//# sourceMappingURL=agent-vault-id.d.ts.map