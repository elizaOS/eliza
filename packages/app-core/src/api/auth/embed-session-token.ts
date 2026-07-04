/**
 * Scoped embed session token (#9947) — the credential minted from a verified
 * embed-launch principal.
 *
 * A cross-origin embedded surface (Discord Activity / Telegram Mini App iframe)
 * cannot use the first-party Steward cookie, so after `verifyEmbedLaunch`
 * succeeds the server mints this self-contained, HMAC-signed bearer token that
 * the embedded SPA presents on its API calls. It carries only the verified
 * `entityId` + `role` + `adminMode` claim and a short expiry — no ambient
 * authority. It is signed with a server secret and verified the same way, so a
 * tampered or expired token fails closed.
 *
 *   token = base64url(JSON(claims)) + "." + base64url(HMAC_SHA256(secret, payload))
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * #12087 Item 30: the single elevated-role set for the embed boundary. Only these
 * roles are ever minted into a token or pass the handshake gate; everything else
 * fails closed. Both the token claims type (below) and the handshake result
 * (`EmbedLaunchResult` in embed-handshake.ts) consume this one definition.
 */
export const EMBED_ELEVATED_ROLES = ["OWNER", "ADMIN"] as const;
export type EmbedRole = (typeof EMBED_ELEVATED_ROLES)[number];

/** Membership guard for {@link EMBED_ELEVATED_ROLES} (fails closed). */
export function isEmbedRole(value: unknown): value is EmbedRole {
  return (
    typeof value === "string" &&
    (EMBED_ELEVATED_ROLES as readonly string[]).includes(value)
  );
}

export interface EmbedSessionClaims {
  /** The account-scoped Eliza entity the verified platform user maps to. */
  entityId: string;
  /** Verified role (only OWNER/ADMIN are ever minted). */
  role: EmbedRole;
  /** Whether the embedded surface runs in ADMIN mode. */
  adminMode: boolean;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/** Default token lifetime (1 hour) — short by design; the embed re-launches. */
export const DEFAULT_EMBED_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Setting keys (in preference order) that supply the HMAC secret used to sign
 * and verify embed session tokens. A dedicated `ELIZA_EMBED_SESSION_SECRET` is
 * preferred; it falls back to the configured `ELIZA_API_TOKEN`.
 */
export const EMBED_SESSION_SECRET_KEYS = [
  "ELIZA_EMBED_SESSION_SECRET",
  "ELIZA_API_TOKEN",
] as const;

/** Minimum secret length; a shorter value is treated as unconfigured. */
export const EMBED_SESSION_SECRET_MIN_LENGTH = 16;

export interface EmbedSessionSecretRuntime {
  getSetting?: (key: string) => unknown;
}

/**
 * Resolve the embed-session HMAC secret from a settings reader (the runtime's
 * `getSetting` at mint time, or `process.env` on the auth path). The mint and
 * verify sides MUST resolve the same secret, so both go through here. Returns
 * `null` when no key is set to a value of at least
 * {@link EMBED_SESSION_SECRET_MIN_LENGTH} characters — the caller then treats
 * embed tokens as unsupported (no minting, no acceptance).
 */
export function resolveEmbedSessionSecret(
  read: (key: string) => unknown,
): string | null {
  for (const key of EMBED_SESSION_SECRET_KEYS) {
    const value = read(key);
    if (
      typeof value === "string" &&
      value.trim().length >= EMBED_SESSION_SECRET_MIN_LENGTH
    ) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Read an embed-session secret key from the runtime first, then from the real
 * process env. Runtime settings win when set, but env-only deployments also
 * work for keys intentionally not forwarded into character settings.
 */
export function readEmbedSessionSecretSetting(
  runtime: EmbedSessionSecretRuntime | null | undefined,
  key: string,
  env: Record<string, string | undefined> = process.env,
): unknown {
  const runtimeValue = runtime?.getSetting?.(key);
  if (typeof runtimeValue === "string" && runtimeValue.trim()) {
    return runtimeValue;
  }
  const envValue = env[key];
  if (typeof envValue === "string" && envValue.trim()) {
    return envValue;
  }
  return runtimeValue;
}

/** Resolve the shared mint/verify secret from runtime settings or process env. */
export function resolveEmbedSessionSecretForRuntime(
  runtime: EmbedSessionSecretRuntime | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return resolveEmbedSessionSecret((key) =>
    readEmbedSessionSecretSetting(runtime, key, env),
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintEmbedSessionToken(
  claims: EmbedSessionClaims,
  secret: string,
): string {
  if (!secret) {
    throw new Error("embed session secret is required to mint a token");
  }
  const payload = base64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a token and return its claims, or `null` when the signature is invalid,
 * the token is malformed, or it has expired. Fails closed in every case.
 */
export function verifyEmbedSessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): EmbedSessionClaims | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payload, secret);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let claims: EmbedSessionClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as EmbedSessionClaims;
  } catch {
    // error-policy:J3 untrusted token payload — a malformed base64/JSON segment
    // yields a null (invalid token) result, never fabricated claims.
    return null;
  }
  if (
    typeof claims.entityId !== "string" ||
    !isEmbedRole(claims.role) ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (now >= claims.exp) {
    return null;
  }
  return claims;
}
