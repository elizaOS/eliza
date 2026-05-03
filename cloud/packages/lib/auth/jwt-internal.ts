/**
 * Internal JWT Authentication
 *
 * JWT signing and verification for service-to-service communication.
 * Used by the Discord gateway and other internal services.
 */

import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import { nanoid } from "nanoid";
import { getAlgorithm, getKeyId, getPrivateKey, getPublicKey } from "./jwks";

/**
 * JWT token lifetime in seconds (1 hour).
 * Gateway should refresh at 80% lifetime (48 minutes).
 */
export const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Issuer claim for internal JWTs.
 */
const ISSUER = "eliza-cloud";

/**
 * Audience claim for internal JWTs.
 */
const AUDIENCE = "eliza-cloud-internal";

/**
 * Claims included in internal service JWTs.
 */
export interface InternalJWTPayload extends JWTPayload {
  /** Subject - the pod name or service identifier */
  sub: string;
  /** Issuer */
  iss: string;
  /** Audience */
  aud: string;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** Expiration (Unix timestamp) */
  exp: number;
  /** JWT ID - unique identifier for revocation */
  jti: string;
  /** Service type (e.g., "discord-gateway") */
  service?: string;
}

/**
 * Result of token verification.
 */
export interface VerificationResult {
  valid: true;
  payload: InternalJWTPayload;
}

/**
 * Options for signing a new token.
 */
export interface SignTokenOptions {
  /** Subject - typically the pod name */
  subject: string;
  /** Service type for additional context */
  service?: string;
  /** Custom expiration in seconds (defaults to TOKEN_LIFETIME_SECONDS) */
  expiresIn?: number;
}

/**
 * Sign a new JWT for an internal service.
 *
 * @param options - Token options including subject and optional service type
 * @returns Object with access_token, token_type, and expires_in
 */
export async function signInternalToken(options: SignTokenOptions): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}> {
  const privateKey = await getPrivateKey();
  const expiresIn = options.expiresIn ?? TOKEN_LIFETIME_SECONDS;
  const jti = nanoid();

  const jwt = await new SignJWT({
    service: options.service,
  })
    .setProtectedHeader({
      alg: getAlgorithm(),
      kid: getKeyId(),
    })
    .setSubject(options.subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setJti(jti)
    .sign(privateKey);

  return {
    access_token: jwt,
    token_type: "Bearer",
    expires_in: expiresIn,
  };
}

/**
 * Verify an internal JWT and extract its payload.
 *
 * @param token - The JWT to verify
 * @returns Verification result with payload if valid
 * @throws Error if token is invalid, expired, or has wrong issuer/audience
 */
export async function verifyInternalToken(token: string): Promise<VerificationResult> {
  const publicKey = await getPublicKey();

  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [getAlgorithm()],
  });

  // Validate required claims exist
  if (!payload.sub) {
    throw new Error("Token missing subject claim");
  }
  if (!payload.jti) {
    throw new Error("Token missing JWT ID claim");
  }

  return {
    valid: true,
    payload: payload as InternalJWTPayload,
  };
}

/**
 * Extract the Bearer token from an Authorization header.
 *
 * @param authHeader - The Authorization header value
 * @returns The token if valid Bearer format, null otherwise
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
}
