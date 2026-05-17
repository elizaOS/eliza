/**
 * Credential tunnel service — parent-side scoped credential delivery.
 *
 * When a spawned coding sub-agent needs a credential it cannot see (e.g.
 * `OPENAI_API_KEY` for a task that requires hitting the OpenAI API), the
 * orchestrator declares a *scope* on the parent runtime: a short-lived,
 * single-use bearer token that names exactly which keys the child is allowed
 * to pull. The parent's owner-only sensitive-request flow then collects the
 * value(s) from the user, encrypts each one with the scope's symmetric key
 * (AES-256-GCM), and the child redeems via the bridge HTTP endpoint by
 * presenting the bearer token. The ciphertext is deleted on redemption.
 *
 * Threat model:
 *   - Only `sha256(scopedToken)` is stored, so a memory snapshot of this
 *     process cannot reveal the bearer token.
 *   - Each scope has a 30-minute TTL.
 *   - One-shot per key: on first retrieve, the ciphertext is wiped and the
 *     key state is marked redeemed. A second retrieve rejects with
 *     `already_redeemed`.
 *   - Tunneling a key not pre-declared at scope creation is rejected.
 *   - The childSessionId is checked on both tunnel and retrieve.
 *
 * Crypto: AES-256-GCM with a per-tunnel random 12-byte IV. The auth tag is
 * appended to the ciphertext for transport. Only `node:crypto`.
 *
 * Logs intentionally exclude scoped tokens, ciphertexts, and credential
 * values. Only the scope id, child session id, and key names are logged.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const TOKEN_BYTES = 32; // 256-bit
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SCOPE_TTL_MS = 30 * 60 * 1000;

export interface DeclareScopeInput {
  childSessionId: string;
  credentialKeys: readonly string[];
}

export interface DeclareScopeResult {
  credentialScopeId: string;
  scopedToken: string;
  /** epoch ms */
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

interface ScopeEntryKeyState {
  /** Hex-encoded `IV || ciphertext || authTag`. Cleared after redemption. */
  encrypted: string | null;
  redeemed: boolean;
}

interface ScopeEntry {
  credentialScopeId: string;
  childSessionId: string;
  scopedTokenHash: string;
  /** sha256 of the raw token bytes — the AES-256-GCM symmetric key. */
  encryptionKey: Buffer;
  expiresAt: number;
  keys: Map<string, ScopeEntryKeyState>;
}

export class CredentialScopeError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unknown_scope"
      | "scope_expired"
      | "session_mismatch"
      | "key_not_in_scope"
      | "already_redeemed"
      | "no_ciphertext"
      | "invalid_token",
    message: string,
  ) {
    super(message);
    this.name = "CredentialScopeError";
  }
}

function sha256(input: Buffer | string): Buffer {
  return createHash("sha256").update(input).digest();
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("hex");
}

function decrypt(encryptedHex: string, key: Buffer): string {
  const buf = Buffer.from(encryptedHex, "hex");
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("ciphertext_too_short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export interface CredentialTunnelService {
  declareScope(input: DeclareScopeInput): DeclareScopeResult;
  tunnelCredential(input: TunnelCredentialInput): void;
  retrieveCredential(input: RetrieveCredentialInput): string;
  expireScopes(now?: number): number;
  /** Test-only: peek at whether a scope still has ciphertext for a key. */
  hasCiphertext(credentialScopeId: string, key: string): boolean;
}

export function createCredentialTunnelService(options?: {
  ttlMs?: number;
  now?: () => number;
}): CredentialTunnelService {
  const ttlMs = options?.ttlMs ?? SCOPE_TTL_MS;
  const now = options?.now ?? (() => Date.now());
  // Primary index: sha256(scopedToken) hex → scope. The plaintext token is
  // never persisted in this process.
  const byTokenHash = new Map<string, ScopeEntry>();
  // Secondary index: scope id → scope. Used by tunnelCredential which only
  // has the scope id (the orchestrator that issued the token is the one
  // calling tunnel; it identifies the scope by id, not by re-presenting the
  // bearer token).
  const byId = new Map<string, ScopeEntry>();

  function dropScope(entry: ScopeEntry): void {
    byTokenHash.delete(entry.scopedTokenHash);
    byId.delete(entry.credentialScopeId);
  }

  function expiredAndDropped(entry: ScopeEntry, currentTime: number): boolean {
    if (entry.expiresAt <= currentTime) {
      dropScope(entry);
      return true;
    }
    return false;
  }

  return {
    declareScope({ childSessionId, credentialKeys }) {
      if (
        typeof childSessionId !== "string" ||
        childSessionId.trim().length === 0
      ) {
        throw new CredentialScopeError(
          "invalid_input",
          "childSessionId is required",
        );
      }
      if (!Array.isArray(credentialKeys) || credentialKeys.length === 0) {
        throw new CredentialScopeError(
          "invalid_input",
          "credentialKeys must be a non-empty array",
        );
      }
      const normalized = new Set<string>();
      for (const raw of credentialKeys) {
        if (typeof raw !== "string" || raw.trim().length === 0) {
          throw new CredentialScopeError(
            "invalid_input",
            "credentialKeys entries must be non-empty strings",
          );
        }
        normalized.add(raw.trim());
      }

      const tokenBytes = randomBytes(TOKEN_BYTES);
      const scopedToken = tokenBytes.toString("hex");
      const scopedTokenHash = sha256(tokenBytes).toString("hex");
      // The encryption key is sha256(token). Derived deterministically from
      // the bearer token, but kept on the scope entry so that
      // `tunnelCredential` (which does not see the token) can still encrypt.
      // Anyone who can read this Map already has memory access to the
      // ciphertexts, so colocating the key with the scope entry does not
      // weaken the threat model: the token hash is what gates retrieval.
      const encryptionKey = sha256(tokenBytes);
      const credentialScopeId = `cred_scope_${randomBytes(8).toString("hex")}`;
      const expiresAt = now() + ttlMs;

      const keys = new Map<string, ScopeEntryKeyState>();
      for (const key of normalized) {
        keys.set(key, { encrypted: null, redeemed: false });
      }

      const entry: ScopeEntry = {
        credentialScopeId,
        childSessionId: childSessionId.trim(),
        scopedTokenHash,
        encryptionKey,
        expiresAt,
        keys,
      };
      byTokenHash.set(scopedTokenHash, entry);
      byId.set(credentialScopeId, entry);

      return { credentialScopeId, scopedToken, expiresAt };
    },

    tunnelCredential({ childSessionId, credentialScopeId, key, value }) {
      if (typeof value !== "string" || value.length === 0) {
        throw new CredentialScopeError(
          "invalid_input",
          "value must be a non-empty string",
        );
      }
      const entry = byId.get(credentialScopeId);
      if (!entry) {
        throw new CredentialScopeError(
          "unknown_scope",
          "credentialScopeId not found",
        );
      }
      if (expiredAndDropped(entry, now())) {
        throw new CredentialScopeError("scope_expired", "scope expired");
      }
      if (entry.childSessionId !== childSessionId) {
        throw new CredentialScopeError(
          "session_mismatch",
          "childSessionId does not match scope owner",
        );
      }
      const state = entry.keys.get(key);
      if (!state) {
        throw new CredentialScopeError(
          "key_not_in_scope",
          `key ${key} not declared in scope`,
        );
      }
      if (state.redeemed) {
        throw new CredentialScopeError(
          "already_redeemed",
          `key ${key} already redeemed`,
        );
      }
      state.encrypted = encrypt(value, entry.encryptionKey);
    },

    retrieveCredential({ childSessionId, key, scopedToken }) {
      if (typeof scopedToken !== "string" || scopedToken.length === 0) {
        throw new CredentialScopeError(
          "invalid_token",
          "scopedToken is required",
        );
      }
      let tokenBytes: Buffer;
      try {
        tokenBytes = Buffer.from(scopedToken, "hex");
      } catch {
        throw new CredentialScopeError("invalid_token", "scopedToken invalid");
      }
      if (tokenBytes.length !== TOKEN_BYTES) {
        throw new CredentialScopeError(
          "invalid_token",
          "scopedToken length invalid",
        );
      }
      const tokenHash = sha256(tokenBytes).toString("hex");
      const entry = byTokenHash.get(tokenHash);
      if (!entry) {
        throw new CredentialScopeError(
          "invalid_token",
          "scopedToken does not match a known scope",
        );
      }
      if (expiredAndDropped(entry, now())) {
        throw new CredentialScopeError("scope_expired", "scope expired");
      }
      if (entry.childSessionId !== childSessionId) {
        throw new CredentialScopeError(
          "session_mismatch",
          "childSessionId does not match scope owner",
        );
      }
      const state = entry.keys.get(key);
      if (!state) {
        throw new CredentialScopeError(
          "key_not_in_scope",
          `key ${key} not in scope`,
        );
      }
      if (state.redeemed) {
        throw new CredentialScopeError(
          "already_redeemed",
          `key ${key} already redeemed`,
        );
      }
      if (!state.encrypted) {
        throw new CredentialScopeError(
          "no_ciphertext",
          `no value tunneled for ${key} yet`,
        );
      }
      const plaintext = decrypt(state.encrypted, entry.encryptionKey);
      state.encrypted = null;
      state.redeemed = true;

      // If every declared key has been redeemed, drop the scope so the
      // bearer token cannot be reused.
      let allRedeemed = true;
      for (const v of entry.keys.values()) {
        if (!v.redeemed) {
          allRedeemed = false;
          break;
        }
      }
      if (allRedeemed) dropScope(entry);

      return plaintext;
    },

    expireScopes(currentTime = now()) {
      let swept = 0;
      for (const entry of [...byTokenHash.values()]) {
        if (entry.expiresAt <= currentTime) {
          dropScope(entry);
          swept += 1;
        }
      }
      return swept;
    },

    hasCiphertext(credentialScopeId, key) {
      const entry = byId.get(credentialScopeId);
      if (!entry) return false;
      return entry.keys.get(key)?.encrypted != null;
    },
  };
}
