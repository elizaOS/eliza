/**
 * Credential Tunnel Service — parent-side broker for sub-agent secret requests.
 *
 * A spawned coding sub-agent (Claude Code, Codex, OpenCode) running in a
 * sealed PTY workspace cannot read the parent agent's vault directly. When
 * the sub-agent discovers it needs an API key (e.g. ANTHROPIC_API_KEY) it
 * asks the parent through this broker.
 *
 * Lifecycle:
 *
 *   1. Sub-agent calls `POST /api/coding-agents/<sid>/credentials/request`
 *      with `{credentialKeys}`. The orchestrator route calls
 *      `declareScope`, which mints a 256-bit `scopedToken` (returned to
 *      the sub-agent over loopback) and stores the sha256 hash keyed scope
 *      record. The token is single-use per key and bound to the child
 *      session + the requested keys.
 *
 *   2. Parent (Eliza) collects each secret from the user via the existing
 *      sensitive-request flow. When the user provides the value, the
 *      parent calls `tunnelCredential`. The plaintext is encrypted with
 *      a key derived from the scoped token's sha256 hash and stored keyed
 *      by `{childSessionId, key}`.
 *
 *   3. Sub-agent long-polls `GET /api/coding-agents/<sid>/credentials/<key>?token=…`.
 *      The route calls `retrieveCredential`. The service hashes the
 *      supplied token to look up the scope, decrypts using that same hash
 *      as the symmetric key, returns the plaintext exactly once, and
 *      deletes both the ciphertext and the per-key authorization.
 *
 *   4. `expireScopes(now)` sweeps any scope past its TTL (default 30 min).
 *
 * Security invariants:
 *   - The plaintext scoped token is never persisted by the service. We
 *     store sha256(token) and use that hash as the AES-GCM key, so the
 *     only party that can decrypt is one who presents the original token
 *     (which only the sub-agent receives, over loopback).
 *   - Ciphertext keyed by `{childSessionId, key}` cannot be read by a
 *     different child session — `retrieveCredential` cross-checks the
 *     scope's `childSessionId` against the caller's claimed session.
 *   - A scoped token is rejected for a given key after that key has been
 *     redeemed; replay is detected via the per-key `redeemedKeys` set.
 *   - We never log secret values, scoped tokens, or ciphertexts.
 *
 * Crypto: only `node:crypto`. sha256 for token hashing + key derivation,
 * AES-256-GCM for value encryption, fresh 96-bit IV per call.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SCOPED_TOKEN_BYTES = 32; // 256-bit
const IV_BYTES = 12; // 96-bit IV is the AES-GCM standard
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min

export type CredentialScopeStatus = "open" | "redeemed" | "expired";

/** Persisted scope record keyed by sha256(scopedToken). */
export interface CredentialScope {
  credentialScopeId: string;
  childSessionId: string;
  credentialKeys: readonly string[];
  expiresAt: number;
  ttlMs: number;
  status: CredentialScopeStatus;
  /** Keys that have been redeemed via retrieveCredential. */
  redeemedKeys: Set<string>;
}

export interface DeclareScopeInput {
  childSessionId: string;
  credentialKeys: readonly string[];
  /** Override default TTL (ms). Mostly for tests. */
  ttlMs?: number;
}

export interface DeclareScopeResult {
  credentialScopeId: string;
  scopedToken: string;
  expiresAt: number;
}

export interface TunnelCredentialInput {
  childSessionId: string;
  credentialScopeId: string;
  key: string;
  value: string;
}

export interface RetrieveCredentialInput {
  childSessionId: string;
  key: string;
  scopedToken: string;
}

export type RetrieveCredentialError =
  | "unknown_token"
  | "wrong_session"
  | "key_not_in_scope"
  | "scope_expired"
  | "scope_redeemed"
  | "no_ciphertext";

export type RetrieveCredentialResult =
  | { ok: true; value: string }
  | { ok: false; error: RetrieveCredentialError };

interface CipherRecord {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export interface CredentialTunnelService {
  declareScope(input: DeclareScopeInput): DeclareScopeResult;
  tunnelCredential(input: TunnelCredentialInput): void;
  retrieveCredential(input: RetrieveCredentialInput): RetrieveCredentialResult;
  expireScopes(now: number): string[];
  /** Test helper: returns count of stored scopes. */
  debugScopeCount(): number;
  /** Test helper: returns count of stored ciphertexts. */
  debugCipherCount(): number;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function ciphertextKey(childSessionId: string, key: string): string {
  return `${childSessionId}::${key}`;
}

export function createCredentialTunnelService(): CredentialTunnelService {
  const scopesByTokenHash = new Map<string, CredentialScope>();
  const scopesById = new Map<string, CredentialScope>();
  /** Reverse lookup: scope -> tokenHash, for tunnelCredential's encryption key. */
  const tokenHashByScopeId = new Map<string, string>();
  const ciphertexts = new Map<string, CipherRecord>();
  let scopeCounter = 0;

  function declareScope(input: DeclareScopeInput): DeclareScopeResult {
    const { childSessionId, credentialKeys, ttlMs } = input;
    if (!childSessionId || childSessionId.length === 0) {
      throw new Error("childSessionId required");
    }
    if (!Array.isArray(credentialKeys) || credentialKeys.length === 0) {
      throw new Error("credentialKeys must be a non-empty array");
    }
    for (const k of credentialKeys) {
      if (typeof k !== "string" || k.length === 0) {
        throw new Error("credentialKeys entries must be non-empty strings");
      }
    }
    const effectiveTtl = ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
      throw new Error("ttlMs must be positive");
    }

    scopeCounter += 1;
    const credentialScopeId = `cred-scope-${Date.now().toString(36)}-${scopeCounter.toString(36)}`;
    const scopedToken = randomBytes(SCOPED_TOKEN_BYTES).toString("hex");
    const tokenHash = sha256Hex(scopedToken);
    const expiresAt = Date.now() + effectiveTtl;

    const scope: CredentialScope = {
      credentialScopeId,
      childSessionId,
      credentialKeys: [...credentialKeys],
      expiresAt,
      ttlMs: effectiveTtl,
      status: "open",
      redeemedKeys: new Set(),
    };
    scopesByTokenHash.set(tokenHash, scope);
    scopesById.set(credentialScopeId, scope);
    tokenHashByScopeId.set(credentialScopeId, tokenHash);

    return { credentialScopeId, scopedToken, expiresAt };
  }

  function tunnelCredential(input: TunnelCredentialInput): void {
    const { childSessionId, credentialScopeId, key, value } = input;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("value must be a non-empty string");
    }
    const scope = scopesById.get(credentialScopeId);
    if (!scope) {
      throw new Error("unknown credentialScopeId");
    }
    if (!timingSafeStringEqual(scope.childSessionId, childSessionId)) {
      throw new Error("childSessionId does not match scope");
    }
    if (!scope.credentialKeys.includes(key)) {
      throw new Error("key not in scope");
    }
    if (scope.status === "expired" || Date.now() > scope.expiresAt) {
      scope.status = "expired";
      throw new Error("scope expired");
    }

    const tokenHash = tokenHashByScopeId.get(credentialScopeId);
    if (!tokenHash) {
      throw new Error("scope token missing");
    }
    const symmetric = Buffer.from(tokenHash, "hex");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", symmetric, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    ciphertexts.set(ciphertextKey(childSessionId, key), {
      iv,
      authTag,
      ciphertext,
    });
  }

  function retrieveCredential(
    input: RetrieveCredentialInput,
  ): RetrieveCredentialResult {
    const { childSessionId, key, scopedToken } = input;
    if (typeof scopedToken !== "string" || scopedToken.length === 0) {
      return { ok: false, error: "unknown_token" };
    }
    const tokenHash = sha256Hex(scopedToken);
    const scope = scopesByTokenHash.get(tokenHash);
    if (!scope) {
      return { ok: false, error: "unknown_token" };
    }
    if (!timingSafeStringEqual(scope.childSessionId, childSessionId)) {
      return { ok: false, error: "wrong_session" };
    }
    if (!scope.credentialKeys.includes(key)) {
      return { ok: false, error: "key_not_in_scope" };
    }
    if (scope.status === "expired" || Date.now() > scope.expiresAt) {
      scope.status = "expired";
      return { ok: false, error: "scope_expired" };
    }
    if (scope.redeemedKeys.has(key)) {
      return { ok: false, error: "scope_redeemed" };
    }
    const cKey = ciphertextKey(childSessionId, key);
    const record = ciphertexts.get(cKey);
    if (!record) {
      return { ok: false, error: "no_ciphertext" };
    }
    const symmetric = Buffer.from(tokenHash, "hex");
    const decipher = createDecipheriv("aes-256-gcm", symmetric, record.iv);
    decipher.setAuthTag(record.authTag);
    let plain: string;
    try {
      const buf = Buffer.concat([
        decipher.update(record.ciphertext),
        decipher.final(),
      ]);
      plain = buf.toString("utf8");
    } catch {
      return { ok: false, error: "no_ciphertext" };
    }
    // Single-use: remove ciphertext and mark key redeemed.
    ciphertexts.delete(cKey);
    scope.redeemedKeys.add(key);
    if (scope.redeemedKeys.size >= scope.credentialKeys.length) {
      scope.status = "redeemed";
    }
    return { ok: true, value: plain };
  }

  function expireScopes(now: number): string[] {
    const expired: string[] = [];
    for (const [tokenHash, scope] of scopesByTokenHash.entries()) {
      if (scope.expiresAt <= now && scope.status !== "expired") {
        scope.status = "expired";
        expired.push(scope.credentialScopeId);
        for (const key of scope.credentialKeys) {
          ciphertexts.delete(ciphertextKey(scope.childSessionId, key));
        }
        scopesByTokenHash.delete(tokenHash);
        tokenHashByScopeId.delete(scope.credentialScopeId);
      }
    }
    return expired;
  }

  return {
    declareScope,
    tunnelCredential,
    retrieveCredential,
    expireScopes,
    debugScopeCount: () => scopesById.size,
    debugCipherCount: () => ciphertexts.size,
  };
}
