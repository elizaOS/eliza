/**
 * Bootstrap-token verifier.
 *
 * The Eliza Cloud control plane mints an RS256-signed JWT, injects it as
 * `ELIZA_CLOUD_BOOTSTRAP_TOKEN`, and the user pastes the same value into the
 * dashboard exactly once. We verify here and reject everything that doesn't
 * match: wrong issuer, wrong container, expired, replayed, signed with the
 * wrong algorithm, or by an unknown key.
 *
 * Hard rule: this module fails closed. There is no `try { … } catch { return
 * { authenticated: true } }` shortcut. Any error path returns
 * `{ ok: false, reason }` and the caller MUST refuse the request.
 */

import type { RuntimeEnvRecord } from "@elizaos/shared";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { AuthStore } from "../../services/auth-store";
import {
  type JwksDocument,
  readCachedJwks,
  writeCachedJwks,
} from "../../services/cloud-jwks-store";

export const BOOTSTRAP_TOKEN_ALG = "RS256";
export const BOOTSTRAP_TOKEN_SCOPE = "bootstrap";

export interface BootstrapTokenClaims {
  iss: string;
  sub: string;
  containerId: string;
  scope: "bootstrap";
  iat: number;
  exp: number;
  jti: string;
}

export type VerifyBootstrapResult =
  | { ok: true; claims: BootstrapTokenClaims }
  | { ok: false; reason: VerifyBootstrapFailureReason };

export type VerifyBootstrapFailureReason =
  | "missing_issuer_env"
  | "missing_container_env"
  | "missing_token"
  | "jwks_fetch_failed"
  | "signature_invalid"
  | "alg_not_allowed"
  | "issuer_mismatch"
  | "claims_invalid"
  | "scope_mismatch"
  | "container_mismatch"
  | "expired"
  | "replay"
  | "store_error";

interface VerifyOptions {
  env?: RuntimeEnvRecord;
  authStore: AuthStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface RawClaims {
  iss?: unknown;
  sub?: unknown;
  containerId?: unknown;
  scope?: unknown;
  iat?: unknown;
  exp?: unknown;
  jti?: unknown;
  [otherProperty: string]: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function shapeClaims(
  payload: RawClaims,
):
  | { ok: true; claims: BootstrapTokenClaims }
  | { ok: false; reason: VerifyBootstrapFailureReason } {
  if (
    !isNonEmptyString(payload.iss) ||
    !isNonEmptyString(payload.sub) ||
    !isNonEmptyString(payload.containerId) ||
    !isNonEmptyString(payload.jti) ||
    !isFiniteNumber(payload.iat) ||
    !isFiniteNumber(payload.exp)
  ) {
    return { ok: false, reason: "claims_invalid" };
  }
  if (payload.scope !== BOOTSTRAP_TOKEN_SCOPE) {
    return { ok: false, reason: "scope_mismatch" };
  }
  return {
    ok: true,
    claims: {
      iss: payload.iss,
      sub: payload.sub,
      containerId: payload.containerId,
      scope: BOOTSTRAP_TOKEN_SCOPE,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    },
  };
}

async function loadJwks(
  issuer: string,
  options: VerifyOptions,
): Promise<JwksDocument | null> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const cached = await readCachedJwks(issuer, { env, now });
  if (cached) return cached;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") return null;
  const candidate = body as { keys?: unknown };
  if (!Array.isArray(candidate.keys)) return null;
  const document: JwksDocument = {
    keys: candidate.keys as JwksDocument["keys"],
  };
  await writeCachedJwks(issuer, document, { env, now });
  return document;
}

/**
 * Verify a bootstrap token.
 *
 * On success the same `jti` is recorded as seen so a second presentation
 * fails immediately with `replay`. The caller must NOT call this twice for
 * the same exchange — `recordJtiSeen` is consumed atomically here.
 */
export async function verifyBootstrapToken(
  token: string,
  options: VerifyOptions,
): Promise<VerifyBootstrapResult> {
  const env = options.env ?? process.env;
  const issuer = env.ELIZA_CLOUD_ISSUER?.trim();
  const expectedContainerId = env.ELIZA_CLOUD_CONTAINER_ID?.trim();
  if (!issuer) return { ok: false, reason: "missing_issuer_env" };
  if (!expectedContainerId)
    return { ok: false, reason: "missing_container_env" };
  if (!token || typeof token !== "string" || token.length < 8) {
    return { ok: false, reason: "missing_token" };
  }

  let jwks: JwksDocument | null;
  try {
    jwks = await loadJwks(issuer, options);
  } catch {
    return { ok: false, reason: "jwks_fetch_failed" };
  }
  if (!jwks || jwks.keys.length === 0) {
    return { ok: false, reason: "jwks_fetch_failed" };
  }

  // jose's local JWKS resolver enforces the algorithm we restrict to via
  // `algorithms`. We pin RS256 explicitly — anything else (notably HS256
  // signed with a leaked secret) MUST be rejected.
  const localJwks = createLocalJWKSet({ keys: jwks.keys });

  let payload: RawClaims;
  try {
    const verified = await jwtVerify(token, localJwks, {
      algorithms: [BOOTSTRAP_TOKEN_ALG],
      issuer,
    });
    payload = verified.payload as RawClaims;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (err as { claim?: string }).claim;
      if (claim === "iss") return { ok: false, reason: "issuer_mismatch" };
      return { ok: false, reason: "claims_invalid" };
    }
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      return { ok: false, reason: "signature_invalid" };
    }
    if (code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JWS_INVALID") {
      return { ok: false, reason: "alg_not_allowed" };
    }
    return { ok: false, reason: "signature_invalid" };
  }

  const shape = shapeClaims(payload);
  if (!shape.ok) return shape;
  const claims = shape.claims;

  if (claims.iss !== issuer) return { ok: false, reason: "issuer_mismatch" };
  if (claims.containerId !== expectedContainerId) {
    return { ok: false, reason: "container_mismatch" };
  }

  const now = options.now?.() ?? Date.now();
  // Defence in depth: jose already rejects expired tokens, but an attacker
  // who controls the signing key could mint with a future `exp` we still
  // refuse to honour beyond reason.
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired" };

  let unseen: boolean;
  try {
    unseen = await options.authStore.recordJtiSeen(claims.jti, now);
  } catch {
    return { ok: false, reason: "store_error" };
  }
  if (!unseen) return { ok: false, reason: "replay" };

  return { ok: true, claims };
}
