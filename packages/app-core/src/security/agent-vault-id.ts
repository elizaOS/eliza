/**
 * Derives the opaque, per-install vault id that namespaces an agent's secrets in
 * the OS keychain. The id is a deterministic sha256 over the canonical state dir
 * (XDG / `ELIZA_STATE_DIR` precedence, realpath-normalized), base64url-truncated
 * behind a stable `mldy1-` prefix, so one install always resolves the same vault
 * and two state dirs never collide. The state-dir logic is inlined rather than
 * imported from core's heavier composition helpers, and the vault id is paired
 * with a secret kind to form the keychain account handle.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readAliasedEnv } from "@elizaos/shared";
import type { SecureStoreSecretKind } from "./platform-secure-store";

/** Fixed Keychain / Secret Service “service” identifier (see docs/guides/platform-secure-store.md). */
export const ELIZA_AGENT_VAULT_SERVICE = "ai.elizaos.agent.vault";

// Inlined state-dir resolution (rather than core's composition helper) that
// reads via the alias-aware `readAliasedEnv`, so a branded prefix (e.g.
// `MILADY_STATE_DIR`) resolves the same vault id without depending on the
// `syncBrandEnvToEliza` process.env mirror.
function resolveStateDir(): string {
  const explicit = readAliasedEnv("ELIZA_STATE_DIR");
  if (explicit) return explicit;
  const namespace = readAliasedEnv("ELIZA_NAMESPACE") || "eliza";
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
