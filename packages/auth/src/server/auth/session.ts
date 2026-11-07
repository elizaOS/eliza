/**
 * SessionManager — JWT-based session creation and verification using jose.
 *
 * jose is a root-level dependency (package.json: "jose": "^6.2.1") so it is
 * available to all packages via the monorepo workspace.
 */

import type { JWTPayload } from "jose";
import {
  checkJwtSecretStrength,
  getJwtSecret,
  signJwtPayload,
  verifyJwtPayload,
} from "./jwt";
import {
  assertTokenNotRevoked,
  revocationStore,
  TokenRevokedError,
} from "./revocation.js";

// ─── Config ────────────────────────────────────────────────────────────────

export interface SessionConfig {
  /** JWT signing secret — at least 32 random bytes recommended. Defaults to STEWARD_JWT_SECRET. */
  secret?: string;
  /** JWT issuer claim. Defaults to "steward" */
  issuer?: string;
  /**
   * Token lifetime expressed as a relative time string understood by jose,
   * e.g. "7d", "24h", "30m". Defaults to "7d".
   */
  expiresIn?: string;
}

// ─── Payload ───────────────────────────────────────────────────────────────

export interface SessionPayload extends JWTPayload {
  userId: string;
  jti: string;
  [key: string]: unknown;
}

// ─── Class ─────────────────────────────────────────────────────────────────

export class SessionManager {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly expiresIn: string;

  constructor(config: SessionConfig) {
    const secret = config.secret ?? getJwtSecret();
    if (!secret || secret.length < 16) {
      throw new Error(
        "SessionManager: JWT secret must be at least 16 characters. Use STEWARD_JWT_SECRET with a long random string in production.",
      );
    }
    // An explicit secret bypasses getJwtSecret(), so re-apply its length
    // policy here: hard-fail below 32 chars in production, warn otherwise.
    if (config.secret !== undefined) {
      checkJwtSecretStrength(config.secret, "SessionManager config.secret");
    }
    this.secret = new TextEncoder().encode(secret);
    this.issuer = config.issuer ?? "steward";
    this.expiresIn = config.expiresIn ?? "7d";
  }

  /**
   * Create a signed JWT for a user session. signJwtPayload guarantees a jti
   * claim, so every session token can be individually revoked.
   *
   * @param userId  The user's UUID or identifier — included as a top-level claim
   * @param extra   Optional additional claims to embed in the token. Spread
   *                BEFORE the authenticated identity and stripped of any jti
   *                or subject, so request-derived claims can never override
   *                the user or pre-select a session jti (SEC-134).
   * @returns       A compact JWT string suitable for use as a session token
   */
  async createSession(
    userId: string,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    const { jti: _extraJti, sub: _extraSub, ...safeExtra } = extra ?? {};
    return signJwtPayload(
      {
        ...safeExtra,
        sub: userId,
        userId,
      },
      this.expiresIn,
      this.secret,
      this.issuer,
    );
  }

  /**
   * Verify and decode a session JWT.
   *
   * Returns the payload (including `userId`) on success, or `null` if the
   * token is invalid, expired, or has been tampered with. Throws
   * TokenRevokedError if the token's jti has been revoked.
   *
   * @param token  The compact JWT string
   */
  async verifySession(token: string): Promise<SessionPayload | null> {
    let payload: JWTPayload;
    try {
      payload = await verifyJwtPayload(token, this.secret, this.issuer);
    } catch {
      // Covers JWTExpired, JWTInvalid, JWSInvalid, etc.
      return null;
    }

    // Sanity-check our custom claims are present
    if (typeof payload.userId !== "string" || typeof payload.jti !== "string") {
      return null;
    }
    // Token-type confusion guard (SEC-055): a refresh JWT shares issuer,
    // audience and signing key with access tokens — never accept it as a
    // session/access token.
    if (payload.tokenType === "refresh") {
      return null;
    }

    await assertTokenNotRevoked(payload);

    return payload as SessionPayload;
  }

  /**
   * Invalidate a session token by adding its JTI to the revocation store until
   * the token's natural expiry. Redis shares this across instances; without
   * REDIS_URL the store is in-memory for single-instance/embedded mode.
   *
   * @param token  The token to invalidate
   */
  async invalidateSession(token: string): Promise<void> {
    const payload = await verifyJwtPayload(token, this.secret, this.issuer);

    if (typeof payload.jti !== "string" || typeof payload.exp !== "number") {
      throw new Error("Session token is missing revocable jti/exp claims");
    }

    await revocationStore.revokeToken(payload.jti, payload.exp);
  }
}

export { TokenRevokedError };
