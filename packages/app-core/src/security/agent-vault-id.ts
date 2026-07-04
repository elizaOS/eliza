/**
 * Derives the opaque, per-install vault id that namespaces an agent's secrets in
 * the OS keychain. The id is a deterministic sha256 over the canonical state dir
 * (XDG / `ELIZA_STATE_DIR` precedence, realpath-normalized), base64url-truncated
 * behind a stable `mldy1-` prefix, so one install always resolves the same vault
 * and two state dirs never collide. Kept dependency-light for the Electrobun
 * bootstrap path (no `@elizaos/core` barrel import), and pairs the vault id with
 * a secret kind to form the keychain account handle.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { SecureStoreSecretKind } from "./platform-secure-store";

/** Fixed Keychain / Secret Service “service” identifier (see docs/guides/platform-secure-store.md). */
export const ELIZA_AGENT_VAULT_SERVICE = "ai.elizaos.agent.vault";

// Keep this dependency-light: platform secure-store modules are imported by
// Electrobun bootstrap code where pulling the @elizaos/core barrel is costly.
function resolveStateDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) return explicit;
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome
    ? path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(homedir(), xdgStateHome)
    : path.join(homedir(), ".local", "state");
  return path.join(stateHome, namespace);
}

/**
 * Canonical state directory for this process. Mirrors the canonical
 * `ELIZA_STATE_DIR` > XDG state home precedence
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
