import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

import type { SecureStoreSecretKind } from "./platform-secure-store";

/** Fixed Keychain / Secret Service “service” identifier (see docs/guides/platform-secure-store.md). */
export const ELIZA_AGENT_VAULT_SERVICE = "ai.elizaos.agent.vault";

/**
 * Canonical state directory for this process. Mirrors the canonical
<<<<<<< HEAD
 * `ELIZA_STATE_DIR` > `ELIZA_STATE_DIR` > `~/.${namespace}` precedence
=======
 * `ELIZA_STATE_DIR` > `~/.${namespace}` precedence
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
 * and uses `realpathSync` when the path exists so symlinks normalize
 * consistently.
 */
export function resolveCanonicalStateDir(): string {
  const resolved = path.resolve(resolveStateDir());
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Opaque vault id for OS secret stores: `mldy1-` + first 16 chars of base64url(sha256(canonicalStateDir)).
 */
export function deriveAgentVaultId(
  canonicalStateDir = resolveCanonicalStateDir(),
): string {
  const hash = createHash("sha256").update(canonicalStateDir, "utf8").digest();
  const token = Buffer.from(hash).toString("base64url").slice(0, 16);
  return `mldy1-${token}`;
}

export function keychainAccountForSecretKind(
  vaultId: string,
  kind: SecureStoreSecretKind,
): string {
  return `${vaultId}:${kind}`;
}
