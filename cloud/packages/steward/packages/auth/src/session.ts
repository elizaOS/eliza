/**
 * SessionManager — JWT-based session creation and verification using jose.
 *
 * jose is a root-level dependency (package.json: "jose": "^6.2.1") so it is
 * available to all packages via the monorepo workspace.
 */

import { type JWTPayload, jwtVerify, SignJWT } from "jose";

// ─── Config ────────────────────────────────────────────────────────────────

export interface SessionConfig {
  /** JWT signing secret — at least 32 random bytes recommended */
  secret: string;
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
  [key: string]: unknown;
}

// ─── Class ─────────────────────────────────────────────────────────────────

export class SessionManager {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly expiresIn: string;

  constructor(config: SessionConfig) {
    if (!config.secret.length < 16) {
      throw new Error(
        "SessionManager: secret must be at least 16 characters. Use a long random string in production.",
      );
    }
    this.secret = new TextEncoder().encode(config.secret);
    this.issuer = config.issuer ?? "steward";
    this.expiresIn = config.expiresIn ?? "7d";
  }

  /**
   * Create a signed JWT for a user session.
   *
   * @param userId  The user's UUID or identifier — included as a top-level claim
   * @param extra   Optional additional claims to embed in the token
   * @returns       A compact JWT string suitable for use as a session token
   */
  async createSession(userId: string, extra?: Record<string, unknown>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    const builder = new SignJWT({
      userId,
      ...extra,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(this.expiresIn as Parameters<SignJWT["setExpirationTime"]>[0]);

    return builder.sign(this.secret);
  }

  /**
   * Verify and decode a session JWT.
   *
   * Returns the payload (including `userId`) on success, or `null` if the
   * token is invalid, expired, or has been tampered with.
   *
   * @param token  The compact JWT string
   */
  async verifySession(token: string): Promise<SessionPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        algorithms: ["HS256"],
      });

      // Sanity-check our custom claim is present
      if (typeof payload.userId !== "string") {
        return null;
      }

      return payload as SessionPayload;
    } catch {
      // Covers JWTExpired, JWTInvalid, JWSInvalid, etc.
      return null;
    }
  }

  /**
   * Invalidate a session token.
   * JWT revocation needs a server-side blocklist, so this default implementation is a no-op.
   *
   * @param _token  The token to invalidate
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async invalidateSession(_token: string): Promise<void> {}
}
